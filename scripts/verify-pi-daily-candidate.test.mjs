import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { candidatePlan, candidateProjectSettings, candidateSourceConfig, candidatePayloadBodies, observeCandidateTask, validateCandidateTurn, candidateTransportCoverage, containsProof, inspectCandidatePrintSession, reviewCandidateCliCommand, candidateCliGuard } from './verify-pi-daily-candidate.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const body = 'complete source <tag> & "quoted"\nlast line';
const file = { sha256: sha(body), bytes: Buffer.byteLength(body), text: body };

const printSession = () => [
  { type: 'session', id: 'fresh-session', version: 3 },
  { type: 'model_change', id: 'model', parentId: null, provider: 'magpie', modelId: 'group/worker' },
  { type: 'message', id: 'user', parentId: 'model', message: { role: 'user', content: [{ type: 'text', text: 'Read the selected reference.' }] } },
  { type: 'context_edit', id: 'projection', parentId: 'user', targetId: 'user', replacement: { content: 'Original task and complete selected body' } },
  { type: 'message', id: 'call', parentId: 'projection', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'sr:Rissued-reference' } }] } },
  { type: 'message', id: 'result', parentId: 'call', message: { role: 'toolResult', toolName: 'read', toolCallId: 'read-1', isError: false, content: [{ type: 'text', text: 'Full reference' }], details: { contextBrokerResource: { snapshotId: 'fixed' } } } },
  { type: 'message', id: 'answer', parentId: 'result', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'stop', content: [{ type: 'text', text: 'The requested facts.' }] } },
];
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const expectedPrintModel = { provider: 'magpie', model: 'group/worker' };

test('native print inspection binds actual model, tool-call/result IDs and context projections to session lines', () => {
  const source = jsonl(printSession()), inspected = inspectCandidatePrintSession(source, expectedPrintModel);
  assert.equal(inspected.sha256, sha(source)); assert.equal(inspected.lines, 7);
  assert.deepEqual(inspected.userLines, [3]);
  assert.equal(inspected.calls[0].callLine, 5); assert.equal(inspected.calls[0].resultLine, 6);
  assert.deepEqual(inspected.calls[0].proofKinds, ['contextBrokerResource']);
  assert.equal(inspected.projections[0].targetId, 'user'); assert.deepEqual(inspected.errors, []);
});

test('native print inspection does not accept fallback models, orphan results, partial JSONL or branched history', () => {
  const rows = printSession();
  for (const mutate of [
    value => { value[1].modelId = 'group/flash'; },
    value => { value[6].message.model = 'another-model'; },
    value => { value[5].message.toolCallId = 'unrelated'; },
    value => { value[5].message.toolName = 'bash'; },
    value => { value[3].parentId = 'model'; },
    value => { value[3].targetId = 'not-in-session'; },
    value => { value[6].message.stopReason = 'error'; },
    value => { value[0].parentSession = '/old/session.jsonl'; },
    value => { value.splice(5, 1); value[5].parentId = 'call'; },
  ]) { const changed = structuredClone(rows); mutate(changed); assert.throws(() => inspectCandidatePrintSession(jsonl(changed), expectedPrintModel)); }
  assert.throws(() => inspectCandidatePrintSession(jsonl(rows).trimEnd(), expectedPrintModel));
});

test('owned print continuation requires the frozen submission count and keeps earlier call identities', () => {
  const rows = printSession();
  rows.push({ type: 'message', id: 'followup', parentId: 'answer', message: { role: 'user', content: [{ type: 'text', text: 'Use the same pinned content.' }] } });
  rows.push({ type: 'message', id: 'followup-answer', parentId: 'followup', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason: 'stop', content: [{ type: 'text', text: 'The original fixed version.' }] } });
  assert.throws(() => inspectCandidatePrintSession(jsonl(rows), expectedPrintModel));
  const review = inspectCandidatePrintSession(jsonl(rows), { ...expectedPrintModel, expectedUserMessages: 2 });
  assert.deepEqual(review.userLines, [3, 8]); assert.equal(review.calls[0].id, 'read-1');
  assert.throws(() => inspectCandidatePrintSession(jsonl(rows), { ...expectedPrintModel, expectedUserMessages: 3 }));
  assert.throws(() => inspectCandidatePrintSession(jsonl(rows), { ...expectedPrintModel, expectedUserMessages: 0 }));
});

test('an explicit retraction of a failed partial model response stays distinct from executed tools', () => {
  const rows = printSession();
  const failed = { ...structuredClone(rows[4]), id: 'partial', parentId: 'projection' };
  failed.message.stopReason = 'error'; failed.message.content[0].id = 'partial-call';
  const retract = { type: 'context_edit', id: 'retract', parentId: 'partial', targetId: 'partial', replacement: null };
  rows[4].parentId = 'retract'; rows.splice(4, 0, failed, retract);
  const review = inspectCandidatePrintSession(jsonl(rows), expectedPrintModel);
  assert.equal(review.calls.length, 1); assert.equal(review.retractedCalls.length, 1);
  assert.equal(review.retractedCalls[0].id, 'partial-call');
  assert.equal(review.retractedCalls[0].retractedLine, 6);
  assert.equal(review.finals[0].stopReason, 'error');
  const noRetraction = structuredClone(rows); noRetraction.splice(5, 1); noRetraction[5].parentId = 'partial';
  assert.throws(() => inspectCandidatePrintSession(jsonl(noRetraction), expectedPrintModel));
});

test('candidate package override changes only the reviewed local package slot', () => {
  assert.deepEqual(candidateProjectSettings('/old/broker', '/candidate/broker'), { packages: [{ source: '/old/broker', extensions: [] }, '/candidate/broker'] });
  assert.throws(() => candidateProjectSettings('/old/broker', '/old/broker'));
  assert.throws(() => candidateProjectSettings('npm:broker', '/candidate/broker'));
});

test('candidate source preserves local discovery and refuses ambiguous daily source changes', () => {
  const original = { skillRoots: ['/real/skills'], ruleRoots: ['/real/rules'], discoveryCatalogs: ['/real/catalog.yaml'], sources: [{ id: 'local', type: 'filesystem', roots: ['/real/other'] }, { id: 'notion', type: 'notion', database: 'old', prefetch: false }] };
  const input = { sourceId: 'notion', database: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cacheDir: '/owned/cache' };
  const candidate = candidateSourceConfig(original, input);
  assert.deepEqual(candidate.skillRoots, original.skillRoots); assert.deepEqual(candidate.sources[0], original.sources[0]);
  assert.equal(original.sources[1].database, 'old'); assert.equal(candidate.sources[1].database, input.database);
  assert.equal(candidateSourceConfig(original, { ...input, noNotion: true }).sources[1].enabled, false);
  assert.throws(() => candidateSourceConfig({ ...original, ruleRoots: ['./relative'] }, input));
  assert.throws(() => candidateSourceConfig({ ...original, sources: [...original.sources, { id: 'extra', type: 'notion' }] }, input));
  assert.throws(() => candidateSourceConfig({ ...original, sources: [{ ...original.sources[1], command: ['fake'] }] }, input));
});

const publicCli = { mode: 'original-create-recovery', operationId: 'original-operation', entry: { path: '/frozen/ntn-skills.js' }, database: 'owned-library', target: 'original-page',
  originalPlan: { path: '/evidence/original-plan.json' }, refPrefix: 'skill://original-owner/', outputRoot: '/evidence/agent-output',
  inputFiles: ['/evidence/original-plan.json', '/evidence/original-error.json'] };
const cliCommand = 'node /frozen/ntn-skills.js';
const reviewCommand = cliCommand + ' ctl library create recovery review /evidence/original-plan.json --entry owned-library --target original-page --output /evidence/agent-output/review.json';

test('public CLI task permits help and only the bound original recovery and strict reads', () => {
  assert.equal(reviewCandidateCliCommand(cliCommand + ' --help', publicCli).kind, 'help');
  assert.equal(reviewCandidateCliCommand(cliCommand + ' ctl library create recovery apply --help', publicCli).kind, 'help');
  assert.equal(reviewCandidateCliCommand(cliCommand + ' schema ctl operation show', publicCli).kind, 'schema');
  assert.equal(reviewCandidateCliCommand(cliCommand + ' ctl operation show original-operation', publicCli).kind, 'operation-show');
  assert.equal(reviewCandidateCliCommand(reviewCommand, publicCli).kind, 'review');
  assert.equal(reviewCandidateCliCommand(reviewCommand.replace(' /evidence/original-plan.json', '') + ' /evidence/original-plan.json', publicCli).kind, 'review');
  const apply = cliCommand + ' ctl library create recovery apply /evidence/original-plan.json --entry owned-library --review /evidence/agent-output/review.json --review-id create-restore-' + 'a'.repeat(64);
  assert.equal(reviewCandidateCliCommand(apply + ' --dry-run', publicCli).dryRun, true);
  assert.equal(reviewCandidateCliCommand(apply, publicCli).dryRun, false);
  assert.equal(reviewCandidateCliCommand(cliCommand + ' ctl library create recovery reconcile --entry owned-library --target original-page /evidence/original-plan.json', publicCli).kind, 'reconcile');
  assert.equal(reviewCandidateCliCommand(reviewCommand + ' --max-requests 100 --duration-ms 60000', publicCli).kind, 'review');
  const read = cliCommand + " read 'skill://original-owner/references/policy.md?snapshot=fixed&file_id=original-file' --database owned-library --read-only --json --metrics";
  assert.equal(reviewCandidateCliCommand(read, publicCli).kind, 'read');
  assert.equal(reviewCandidateCliCommand(read, publicCli).argv[3], 'skill://original-owner/references/policy.md?snapshot=fixed&file_id=original-file');
  assert.equal(reviewCandidateCliCommand(cliCommand + ' read --json --metrics --read-only --database owned-library --path references/policy.md original-page', publicCli).kind, 'read');
  assert.equal(reviewCandidateCliCommand(cliCommand + " read references/policy.md --from 'skill://original-owner/SKILL.md?snapshot=fixed&file_id=original-file' --database owned-library --read-only --json --metrics", publicCli).kind, 'read');
  assert.equal(reviewCandidateCliCommand(cliCommand + " files 'skill://original-owner/SKILL.md?snapshot=s_" + 'a'.repeat(64) + "&file_id=original-file' --database owned-library --metrics", publicCli).kind, 'files');
});

test('public CLI scope rejects shell composition, replacement plans, owners and unbounded output', () => {
  for (const command of [
    reviewCommand + '; node other.js', reviewCommand + '\nnode other.js', reviewCommand + ' | cat',
    'python private-store.py', reviewCommand.replace('/frozen/ntn-skills.js', '/other/cli.js'),
    reviewCommand.replace('create recovery review /evidence/original-plan.json', 'create /replacement'),
    reviewCommand.replace('/evidence/original-plan.json', '/evidence/replacement-plan.json'),
    reviewCommand.replace('--entry owned-library', '--entry another-library'),
    reviewCommand.replace('--target original-page', '--target replacement-page'),
    reviewCommand.replace('/evidence/agent-output/review.json', '/evidence/original-plan.json'),
    reviewCommand.replace('/evidence/agent-output/review.json', '/evidence/agent-output/../outside.json'),
    cliCommand + ' --help > /tmp/overwrite', cliCommand + ' --help$(id)',
    cliCommand + ' ctl operation show another-operation', cliCommand + ' ctl operation resume original-operation',
    reviewCommand + ' --json --metrics', reviewCommand + ' --dry-run', reviewCommand + ' --max-requests 2001',
    cliCommand + ' ctl library create recovery apply /evidence/original-plan.json --entry owned-library',
    cliCommand + ' ctl library create recovery reconcile /evidence/original-plan.json --entry owned-library --target original-page --output /evidence/agent-output/unsupported.json',
    cliCommand + ' read original-page --database owned-library --json --metrics',
    cliCommand + ' read another-page --database owned-library --read-only --json --metrics',
    cliCommand + " read references/policy.md --from skill://another-owner/SKILL.md --database owned-library --read-only --json --metrics",
    cliCommand + ' read original-page --path ../outside --database owned-library --read-only --json --metrics',
    cliCommand + ' files original-page --database owned-library --metrics',
    cliCommand + " files 'skill://another-owner/SKILL.md?snapshot=s_" + 'a'.repeat(64) + "' --database owned-library --metrics",
  ]) assert.throws(() => reviewCandidateCliCommand(command, publicCli), command);
});

test('public CLI guard blocks before execution and confines native file reads to disclosed artifacts', () => {
  const handlers = new Map(), records = [];
  candidateCliGuard({ on(name, fn) { handlers.set(name, fn); } }, { fs: { openSync: () => 1, writeSync: (_fd, text) => records.push(JSON.parse(text)), closeSync() {} },
    output: '/evidence/guard.jsonl', policy: publicCli, review: reviewCandidateCliCommand });
  assert.equal(handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'help', input: { command: cliCommand + ' --help' } }), undefined);
  assert.equal(handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'private', input: { command: 'python store.py' } }).block, true);
  assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'plan', input: { path: publicCli.originalPlan.path } }), undefined);
  assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'outside', input: { path: '/unrelated/secret' } }).block, true);
  handlers.get('session_shutdown')({});
  assert.deepEqual(records.map(record => record.allowed ?? record.complete), [true, false, true, false, true]);
});

test('public CLI guard admits only the exact host spill from an approved Bash result', () => {
  const handlers = new Map(), records = [], spill = '/tmp/pi-bash-cbd1aed4d1a765d7.log';
  candidateCliGuard({ on(name, fn) { handlers.set(name, fn); } }, { fs: { openSync: () => 1, writeSync: (_fd, text) => records.push(JSON.parse(text)), closeSync() {} },
    output: '/evidence/guard.jsonl', policy: publicCli, review: reviewCandidateCliCommand });
  const read = path => handlers.get('tool_call')({ toolName: 'read', toolCallId: 'read-' + records.length, input: { path } });
  const result = { toolName: 'bash', toolCallId: 'approved', details: { fullOutputPath: spill, truncation: { truncated: true } } };
  assert.equal(read(spill).block, true);
  handlers.get('tool_result')(result); assert.equal(read(spill).block, true, 'An unmatched result cannot authorize a filesystem read');
  assert.equal(handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'approved', input: { command: reviewCommand } }), undefined);
  handlers.get('tool_result')({ ...result, details: { ...result.details, fullOutputPath: '/unrelated/secret' } });
  assert.equal(read('/unrelated/secret').block, true);
  handlers.get('tool_result')({ ...result, details: { fullOutputPath: spill } }); assert.equal(read(spill).block, true);
  const before = structuredClone(result); assert.equal(handlers.get('tool_result')(result), undefined); assert.deepEqual(result, before);
  assert.equal(read(spill), undefined);
  assert.equal(read('/tmp/pi-bash-0000000000000000.log').block, true);
  assert.deepEqual(records.filter(row => row.phase === 'public-cli-output'), [
    { phase: 'public-cli-output', sourceToolCallId: 'approved', artifactPath: spill, allowed: true },
  ]);
});

test('exact body counts exclude tool definitions, details, and call arguments, reject partials, and detect duplicates', () => {
  const payload = { tools: [{ description: body }], messages: [{ role: 'assistant', tool_calls: [{ arguments: body }], details: { body } }, { role: 'tool', content: body }] };
  assert.equal(candidatePayloadBodies(payload, [file])[0].occurrences, 1);
  assert.equal(candidatePayloadBodies({ messages: [{ content: body.slice(0, -1) }] }, [file])[0].occurrences, 0);
  assert.equal(candidatePayloadBodies({ messages: [{ content: body + '\n' + body }] }, [file])[0].occurrences, 2);
  assert.equal(candidatePayloadBodies({ messages: [{ content: JSON.stringify({ content: body }) }] }, [file])[0].occurrences, 1);
});

test('candidate View is explicit, remains in the same source, and cannot leak from a different library', () => {
  const database = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const viewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const original = { sources: [{ id: 'notion', type: 'notion', database, default_view_id: viewId, prefetch: false }] };
  const input = { sourceId: 'notion', database, cacheDir: '/owned/cache' };
  assert.equal(candidateSourceConfig(original, input).sources[0].default_view_id, viewId);
  const selected = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  assert.equal(candidateSourceConfig(original, { ...input, viewId: selected }).sources[0].default_view_id, selected);
  assert.equal(original.sources[0].default_view_id, viewId);
  assert.throws(() => candidateSourceConfig(original, { ...input, database: selected }));
  assert.equal(candidateSourceConfig(original, { ...input, database: selected, viewId }).sources[0].default_view_id, viewId);
  for (const invalid of ['', 'first', null, true]) assert.throws(() => candidateSourceConfig(original, { ...input, viewId: invalid }));
});

test('proof matching cannot combine owner and snapshot from different records', () => {
  const values = [{ owner: 'correct', snapshot: 'wrong' }, { owner: 'wrong', snapshot: 'correct' }];
  assert.equal(containsProof(values, { owner: 'correct', snapshot: 'correct' }), false);
  assert.equal(containsProof(values, { owner: 'correct', snapshot: 'wrong' }), true);
});

function observed() {
  return {
    costs: [{ phase: 'provider_request', payload: { sha256: 'payload', bytes: 100, verifiedBodyOccurrences: [{ sha256: file.sha256, occurrences: 1 }] } }],
    transport: [{ phase: 'request_start', id: 1, category: 'model' }, { phase: 'request_sent', id: 1, requestBodySha256: 'payload', requestBodyBytes: 100 }, { phase: 'request_end', id: 1, category: 'model', status: 200, outcome: 'completed' }],
    tasks: [{ phase: 'provider_payload', sha256: 'payload', bytes: 100, bodies: [{ sha256: file.sha256, occurrences: 1 }] }, { phase: 'receipt', proofs: { one: { owner: 'right', snapshot: 'pin' } } }, { phase: 'assistant_final', success: true, sha256: 'answer', bytes: 10 }],
  };
}

test('a positive verdict binds full body, receipt, final answer, and the actual HTTP payload', () => {
  const turn = { bodies: [{ sha256: file.sha256, occurrences: 1 }], proofs: [{ owner: 'right', snapshot: 'pin' }] };
  assert.equal(validateCandidateTurn(turn, observed()).semanticReview, 'required');
  for (const change of [
    value => { value.transport[1].requestBodySha256 = 'different'; },
    value => { value.transport.at(-1).outcome = 'failure'; },
    value => { value.costs[0].payload.verifiedBodyOccurrences = []; },
    value => { value.tasks[0].bodies[0].occurrences = 2; },
    value => { value.tasks[1].proofs.one.snapshot = 'new-pin'; },
    value => { value.tasks.at(-1).success = false; },
    value => { value.tasks.push({ phase: 'tool_call', executionTool: true }); },
  ]) { const value = observed(); change(value); assert.throws(() => validateCandidateTurn(turn, value)); }
  assert.throws(() => validateCandidateTurn({ ...turn, requireUse: true }, observed()), /notion_use/u);
  const stale = observed();
  stale.tasks.push({ phase: 'tool_call', toolName: 'notion_use', toolCallId: 'new', reviewedReadTool: true },
    { phase: 'tool_result', toolCallId: 'new', isError: true }, { phase: 'receipt', toolCallId: 'old', proofs: { contextBrokerPreparation: { purpose: 'use', toolCallId: 'old' } } });
  assert.throws(() => validateCandidateTurn({ ...turn, requireUse: true }, stale), /notion_use/u);
  assert.equal(validateCandidateTurn({ ...turn, toolCallCount: 0 }, observed()).semanticReview, 'required');
  assert.throws(() => validateCandidateTurn({ ...turn, toolCallCount: 0 }, stale), /frozen turn intent/u);
});

test('normal-host transport retains unknown other requests without mistaking them for incomplete model work', () => {
  const events = [
    { phase: 'request_start', id: 1, category: 'model' },
    { phase: 'request_end', id: 1, category: 'model', outcome: 'completed' },
    { phase: 'request_start', id: 2, category: 'other' },
    { phase: 'transport_end', errors: 0, complete: false, incompleteRequestIds: [2] },
  ];
  const original = structuredClone(events);
  assert.deepEqual(candidateTransportCoverage(events), {
    scope: 'selected-model-and-separately-validated-source', allRequestsComplete: false,
    model: { attempts: 1, complete: true }, other: { attempts: 1, complete: false, unknownRequestIds: [2] },
  });
  assert.deepEqual(events, original);
  const pendingModel = structuredClone(events); pendingModel.at(-1).incompleteRequestIds = [1, 2];
  assert.throws(() => candidateTransportCoverage(pendingModel), /selected-model/u);
  const observerError = structuredClone(events); observerError.at(-1).errors = 1;
  assert.throws(() => candidateTransportCoverage(observerError), /observer error/u);
  const unknownId = structuredClone(events); unknownId.at(-1).incompleteRequestIds = [3];
  assert.throws(() => candidateTransportCoverage(unknownId));
});

test('candidate plan is nonexecuting and rejects unfrozen body claims', () => {
  assert.equal(candidatePlan({ version: 1, scope: 'project-scoped-candidate-precheck', turns: [{ id: 'inspect', prompt: 'Original task' }] }).status, 'prepared_not_executed');
  assert.throws(() => candidatePlan({ version: 1, scope: 'project-scoped-candidate-precheck', turns: [{ id: 'inspect', prompt: 'Original task', bodies: [{ sha256: file.sha256, occurrences: 1 }] }] }));
});

test('task observer does not transform provider input or register tools/providers', () => {
  const handlers = new Map(), writes = [];
  const fs = { openSync: () => 1, readFileSync: () => Buffer.from(body), writeSync: (_fd, line) => writes.push(JSON.parse(line)), closeSync: () => {} };
  observeCandidateTask({ on(name, fn) { handlers.set(name, fn); } }, { fs, crypto: { createHash }, output: '/owned/task.jsonl', bodyFiles: [file], inspectPayload: candidatePayloadBodies });
  const payload = { messages: [{ content: body }] }, before = structuredClone(payload);
  assert.equal(handlers.get('before_provider_request')({ payload }), undefined); assert.deepEqual(payload, before);
  assert.equal(writes.at(-1).bodies[0].occurrences, 1);
  handlers.get('session_shutdown')({}); assert.equal(writes.at(-1).complete, true);
});
