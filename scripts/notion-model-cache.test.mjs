import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtemp, readFile, realpath, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verificationCliEnvironment } from './verification-paths.mjs';
import { invokeJson } from './verification-command.mjs';
import { assertModelCase, requestCounts, cacheCaseDirectory, modelAvailabilityFailure, validateIntentConfiguration, assertIntentTurn, assertIntentSource, validateIntentReview } from './verify-pi-notion-model-cache.mjs';
import * as intentRunner from './verify-pi-notion-model-cache.mjs';
import { observe } from './notion-integration-model.mjs';
import { createPiHelpBoundary } from './notion-pi-help.mjs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

const expected = ['WORKFLOW-A', 'CHECKLIST-A', 'HOLD', 'CODE-1'];
const intentHash = text => crypto.createHash('sha256').update(text).digest('hex');
const intentConfig = () => {
  const prompt = text => ({ text, sha256: intentHash(text) });
  return { version: 1, contract: 'agent-cli-ref-20261105', phase: 'early-feedback-not-formal-SC21', model: 'magpie/group/flash-free', fallback: 'forbidden',
    sampling: { codeMode: false, tools: ['read', 'notion_list', 'notion_use'] },
    budget: { primarySamplesPerCase: 1, primaryCases: 4, maxFollowupSubmissions: 3, maxSubmissions: 7, timeoutMsPerSubmission: 300000,
      maxScheduledPromptMs: 2100000, automaticRetries: 0, continueAfterFailedPrerequisite: false },
    source: { sourceMode: 'sdk', prefetch: false, catalogEvidence: { count: 74 } }, privateOracle: { consumerVisible: false, noPrivateTargetSeedForD: true },
    cases: [
      { id: 'C-introduce', entryMode: 'explicit-root', intent: 'introduce', initial: prompt('$public 介绍'), followups: [{ intent: 'reuse-introduction', prompt: prompt('继续') }, { intent: 'explicit-reread', prompt: prompt('再次读取') }] },
      { id: 'D-named-introduce', entryMode: 'discovery-only', intent: 'introduce', initial: prompt('介绍能力'), followups: [{ mode: 'restart-and-resume-same-session', intent: 'reuse-introduction', prompt: prompt('继续说明') }] },
      { id: 'D-natural-task', entryMode: 'discovery-only', intent: 'produce-and-exercise-artifact', initial: prompt('建立验收规程'), followups: [] },
      { id: 'D-chat', entryMode: 'discovery-only', intent: 'chat', initial: prompt('你好'), followups: [] },
    ] };
};

test('C/D keeps the approved budget and production default without private discovery seeds', () => {
  assert.equal(validateIntentConfiguration(intentConfig()).model, 'magpie/group/flash-free');
  for (const mutate of [
    value => { value.budget.automaticRetries = 1; }, value => { value.budget.timeoutMsPerSubmission = 600000; },
    value => { value.source.default_view_id = 'root-only'; }, value => { value.source.command = ['old-cli']; },
    value => { value.cases[1].rootRef = 'skill://private/SKILL.md'; },
    value => { value.cases[2].initial = { text: 'skill://private/SKILL.md', sha256: intentHash('skill://private/SKILL.md') }; },
    value => { value.model = 'magpie/group/worker'; }, value => { value.privateOracle.consumerVisible = true; },
  ]) { const config = intentConfig(); mutate(config); assert.throws(() => validateIntentConfiguration(config)); }
});

test('intent case selection preserves all frozen cases and budgets while selecting only C explicitly', () => {
  const config = intentConfig(), original = structuredClone(config), all = intentRunner.selectIntentCases(config);
  assert.equal(all.mode, 'all'); assert.deepEqual(all.selectedCaseIds, config.cases.map(item => item.id));
  assert.deepEqual(all.notRunCases, []); assert.equal(all.plannedBudget.maxSubmissions, 7);
  assert.equal(all.plannedBudget.maxScheduledPromptMs, 2100000);
  const selected = intentRunner.selectIntentCases(config, 'C-introduce');
  assert.equal(selected.mode, 'targeted'); assert.deepEqual(selected.selectedCaseIds, ['C-introduce']);
  assert.deepEqual(selected.notRunCases, config.cases.slice(1).map(item => ({ id: item.id, status: 'not_run', reason: 'not_selected_for_early_feedback' })));
  assert.deepEqual(selected.plannedBudget, { primarySamplesPerCase: 1, primaryCases: 1, maxFollowupSubmissions: 2, maxSubmissions: 3,
    timeoutMsPerSubmission: 300000, maxScheduledPromptMs: 900000, automaticRetries: 0, continueAfterFailedPrerequisite: false });
  assert.deepEqual(config, original, 'Selection must not trim the full contract or rewrite its budgets/prompts');
  for (const id of ['', 'D-named-introduce', 'unknown', ['C-introduce']]) assert.throws(() => intentRunner.selectIntentCases(config, id));
  for (const mutate of [value => { value.cases.pop(); }, value => { value.cases[2].initial.text = 'changed unselected D'; },
    value => { value.budget.automaticRetries = 1; }, value => { value.source.default_view_id = 'private-singleton'; }]) {
    const invalid = intentConfig(); mutate(invalid); assert.throws(() => intentRunner.selectIntentCases(invalid, 'C-introduce'));
  }
});

test('intent case selection never turns a C-only success into full-suite acceptance', () => {
  const config = intentConfig(), all = intentRunner.selectIntentCases(config), selected = intentRunner.selectIntentCases(config, 'C-introduce');
  const completed = [{ id: 'C-introduce', status: 'passed' }];
  assert.equal(intentRunner.intentRunStatus(selected, completed), 'review_required');
  assert.equal(intentRunner.intentRunStatus(selected, completed, 'passed'), 'partial');
  assert.equal(intentRunner.intentRunStatus(selected, completed, 'failed'), 'failed');
  assert.equal(intentRunner.intentRunStatus(selected, [{ id: 'C-introduce', status: 'failed' }], 'passed'), 'failed');
  assert.equal(intentRunner.intentRunStatus(all, completed, 'passed'), 'failed');
  const full = config.cases.map(item => ({ id: item.id, status: 'passed' }));
  assert.equal(intentRunner.intentRunStatus(all, full), 'review_required');
  assert.equal(intentRunner.intentRunStatus(all, full, 'passed'), 'passed');
  assert.throws(() => intentRunner.intentRunStatus(selected, [...completed, completed[0]], 'passed'));
  assert.throws(() => intentRunner.intentRunStatus(selected, [{ id: 'D-chat', status: 'passed' }], 'passed'));
});

test('intent case selection has an explicit CLI option without entering the legacy custom-source matrix', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-pi-notion-model-cache.mjs', '--help'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /--intent-case C-introduce/); assert.match(result.stdout, /C-introduce\|D-early/);
  const mixed = spawnSync(process.execPath, ['scripts/verify-pi-notion-model-cache.mjs', '--intent-case', 'C-introduce'], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.notEqual(mixed.status, 0); assert.match(mixed.stderr, /intent-case requires --intent-config/);
});

test('intent case selection explicitly runs the three D cases without resubmitting C', () => {
  const config = intentConfig(), original = structuredClone(config), selected = intentRunner.selectIntentCases(config, 'D-early');
  assert.equal(selected.mode, 'targeted');
  assert.deepEqual(selected.selectedCaseIds, ['D-named-introduce', 'D-natural-task', 'D-chat']);
  assert.deepEqual(selected.notRunCases, [{ id: 'C-introduce', status: 'not_run', reason: 'not_selected_for_early_feedback' }]);
  assert.deepEqual(selected.plannedBudget, { primarySamplesPerCase: 1, primaryCases: 3, maxFollowupSubmissions: 1, maxSubmissions: 4,
    timeoutMsPerSubmission: 300000, maxScheduledPromptMs: 1200000, automaticRetries: 0, continueAfterFailedPrerequisite: false });
  assert.deepEqual(config, original, 'D selection keeps all original prompts, conditions and the full configuration');
  for (const id of ['D', 'D-chat', 'D-natural-task', ['D-early'], 'D-early,C-introduce']) assert.throws(() => intentRunner.selectIntentCases(config, id));
  for (const mutate of [value => { value.cases.shift(); }, value => { value.cases[0].initial.text = 'changed unselected C'; },
    value => { value.cases[1].followups.pop(); }, value => { value.budget.timeoutMsPerSubmission = 600000; },
    value => { value.budget.automaticRetries = 1; }, value => { value.source.default_view_id = 'private-singleton'; }]) {
    const invalid = intentConfig(); mutate(invalid); assert.throws(() => intentRunner.selectIntentCases(invalid, 'D-early'));
  }
});

test('intent case selection cannot count C or a partial D run as completed D early feedback', () => {
  const selected = intentRunner.selectIntentCases(intentConfig(), 'D-early');
  const completed = selected.selectedCaseIds.map(id => ({ id, status: 'passed' }));
  assert.equal(intentRunner.intentRunStatus(selected, completed), 'review_required');
  assert.equal(intentRunner.intentRunStatus(selected, completed, 'passed'), 'partial');
  assert.equal(intentRunner.intentRunStatus(selected, completed, 'failed'), 'failed');
  assert.equal(intentRunner.intentRunStatus(selected, completed.slice(0, 2), 'passed'), 'failed');
  assert.equal(intentRunner.intentRunStatus(selected, completed.map((item, i) => i === 1 ? { ...item, status: 'failed' } : item), 'passed'), 'failed');
  assert.throws(() => intentRunner.intentRunStatus(selected, [{ id: 'C-introduce', status: 'passed' }, ...completed], 'passed'));
  assert.throws(() => intentRunner.intentRunStatus(selected, [...completed, completed[0]], 'passed'));
  assert.throws(() => intentRunner.intentRunStatus(selected, [completed[1], completed[0], completed[2]], 'passed'));
});

test('SC06 discovery experiment is explicit, D-only and keeps the original complete contract', () => {
  const normal = intentConfig(), original = structuredClone(normal);
  for (const mode of ['full-cards', 'on-demand-cards']) {
    const config = { ...structuredClone(normal), phase: 'SC06-discovery-prototype', discoveryExperiment: { version: 1, mode } };
    assert.equal(validateIntentConfiguration(config), config);
    const selected = intentRunner.selectIntentCases(config, 'D-early');
    assert.deepEqual(selected.selectedCaseIds, ['D-named-introduce', 'D-natural-task', 'D-chat']);
    assert.deepEqual(selected.plannedBudget, intentRunner.selectIntentCases(normal, 'D-early').plannedBudget);
    assert.deepEqual(config.cases, original.cases);
    assert.throws(() => intentRunner.selectIntentCases(config), /D-early/);
    assert.throws(() => intentRunner.selectIntentCases(config, 'C-introduce'), /D-early/);
  }
  assert.deepEqual(normal, original);
});

test('SC06 discovery experiment cannot silently replace normal SC21 or change source and budget', () => {
  for (const mutate of [
    value => { value.phase = 'early-feedback-not-formal-SC21'; },
    value => { delete value.discoveryExperiment; },
    value => { value.discoveryExperiment.mode = 'hide-all-system'; },
    value => { value.discoveryExperiment.version = 2; },
    value => { value.discoveryExperiment.target = 'private'; },
    value => { value.source.default_view_id = 'narrowed'; },
    value => { value.source.catalogEvidence.count = 1; },
    value => { value.budget.automaticRetries = 1; },
    value => { value.budget.timeoutMsPerSubmission = 600000; },
  ]) {
    const config = { ...intentConfig(), phase: 'SC06-discovery-prototype', discoveryExperiment: { version: 1, mode: 'on-demand-cards' } };
    mutate(config); assert.throws(() => intentRunner.selectIntentCases(config, 'D-early'));
  }
});

test('SC06 comparison identity allows only the arm and evidence path to differ', () => {
  const a = { ...intentConfig(), phase: 'SC06-discovery-prototype', evidenceRoot: '/owned/full',
    discoveryExperiment: { version: 1, mode: 'full-cards' }, candidate: { runtimeSha256: 'same-runtime' }, harness: [{ path: '/same/observer', sha256: 'same' }] };
  const b = { ...structuredClone(a), evidenceRoot: '/owned/demand', discoveryExperiment: { version: 1, mode: 'on-demand-cards' } };
  assert.equal(intentRunner.discoveryExperimentIdentity(a).comparisonSha256, intentRunner.discoveryExperimentIdentity(b).comparisonSha256);
  for (const change of [
    value => { value.candidate.runtimeSha256 = 'other'; },
    value => { value.cases[1].initial.text = 'different task'; },
    value => { value.source.catalogEvidence.sha256 = 'different directory'; },
    value => { value.sampling.codeMode = true; },
    value => { value.budget.automaticRetries = 1; },
    value => { value.harness[0].sha256 = 'different observer'; },
  ]) {
    const changed = structuredClone(b); change(changed);
    assert.notEqual(intentRunner.discoveryExperimentIdentity(a).comparisonSha256, intentRunner.discoveryExperimentIdentity(changed).comparisonSha256);
  }
  assert.equal(intentRunner.discoveryExperimentIdentity(intentConfig()), undefined);
});

const introInput = () => {
  const target = { logicalId: 'target', scope: 'scope', snapshot: 's_pin', bodySha256: 'b'.repeat(64), bodyBytes: 100, ref: 'skill://target/SKILL.md?snapshot=s_pin' };
  const file = { ...target, ownerId: target.logicalId, role: 'entrypoint', sha256: target.bodySha256, bytes: target.bodyBytes };
  const provider = contents => ({ phase: 'provider-request', tools: ['read', 'notion_list', 'notion_use'], payloadBytes: 500, contents });
  return { item: intentConfig().cases[1], oracle: { target }, catalogRecords: [{ id: 'target', name: 'Target' }], responses: [],
    observation: [provider([]), { phase: 'provider-transport-response', status: 200 },
      { phase: 'tool-result', tool: 'read', complete: true, ...file }, provider([file]),
      { phase: 'assistant-final', success: true, text: 'Creates project verification procedures.' }] };
};

test('introduction requires complete inspected source and never target activation or hidden preload', () => {
  assert.equal(assertIntentTurn(introInput()).semantic_review, 'required');
  for (const mutate of [
    value => { value.observation[2].snapshot = 's_other'; },
    value => { value.observation[3].contents[0].bytes = 99; },
    value => { value.observation[0].contents = value.observation[3].contents; },
    value => { value.observation[3].contents.push({ ...value.observation[3].contents[0] }); },
    value => { value.responses = [{ command: 'prepare', code: 0, response: { status: 'ready', purpose: 'use', nodes: [{ id: 'target' }] } }]; },
    value => { value.observation.push({ phase: 'tool-call', allowed: false }); },
  ]) { const input = introInput(); mutate(input); assert.throws(() => assertIntentTurn(input)); }
});

for (const [sourceName, encodedName] of [
  ['Target "quoted"', 'Target &quot;quoted&quot;'],
  ['Target &quot; &amp;quot; &lt;', 'Target &amp;quot; &amp;amp;quot; &amp;lt;'],
]) test('intent catalogue metadata decodes one layer for ' + encodedName, () => {
  const value = introInput();
  value.catalogRecords[0].name = sourceName;
  const catalog = { phase: 'catalog', state: 'ready', skills: [{ name: encodedName,
    provenance: { ownerId: 'target', source: 'verified-notion-metadata', scope: 'scope', loaded: false } }] };
  value.observation.unshift(catalog);
  assert.equal(assertIntentTurn(value).status, 'passed');
  catalog.skills[0].name = encodedName + ' altered';
  assert.throws(() => assertIntentTurn(value), /actual record name/);
  catalog.skills[0].name = encodedName;
  catalog.skills[0].provenance.scope = 'another-scope';
  assert.throws(() => assertIntentTurn(value));
  catalog.skills[0].provenance.scope = 'scope';
  catalog.skills[0].provenance.ownerId = 'another-owner';
  assert.throws(() => assertIntentTurn(value), /actual production 74/);
});

test('ordinary reuse, explicit reread and chat keep different source obligations', () => {
  const reused = introInput(); reused.followup = true; reused.intent = 'reuse-introduction'; reused.newResponses = [{ operation: 'consume' }];
  assert.throws(() => assertIntentTurn(reused), /silently read/);
  const reread = introInput(); reread.followup = true; reread.intent = 'explicit-reread'; reread.newResponses = [];
  assert.equal(assertIntentTurn(reread).status, 'passed');
  reread.turnObservation = reread.observation.filter(event => event.phase !== 'tool-result');
  assert.throws(() => assertIntentTurn(reread), /own actual read result/);
  const chat = introInput(); chat.item = intentConfig().cases[3];
  assert.throws(() => assertIntentTurn(chat), /Chat cannot/);
  chat.observation = [chat.observation[0], chat.observation[1], chat.observation.at(-1)];
  assert.equal(assertIntentTurn(chat).status, 'passed');
  const pending = introInput(); pending.observation.unshift({ phase: 'catalog', state: 'pending' });
  assert.equal(assertIntentTurn(pending).status, 'passed');
  pending.followup = true; assert.throws(() => assertIntentTurn(pending), /continuation must expose ready/);
});

const intentSource = () => ({
  observation: [], responses: [{ transport: 'sdk', operation: 'list', requestId: 'one', status: 'completed',
    sdk_started: true, metrics_observed: true, resultObserved: true, value: { records: [], scope: 'scope' }, metrics: { complete: true, total_requests: 0, trace: [] } }],
  sourceLedger: [{ phase: 'sdk-observer-start', pid: 42 }, { phase: 'sdk-start', requestId: 'one', operation: 'list', pid: 42, monotonic_ns: '10' },
    { phase: 'sdk-end', requestId: 'one', operation: 'list', pid: 42, monotonic_ns: '30' }, { phase: 'sdk-observer-end', pid: 42, pending: 0 }],
  hostLedger: [{ event: 'spawn', pid: 42 }, { event: 'close', pid: 42, observedExit: true }], scope: 'scope',
});

test('intent source ledger rejects missing costs, hidden writes, unowned bodies and unfinished processes', () => {
  assert.equal(assertIntentSource(intentSource()).actual_http_attempts, 0);
  for (const mutate of [
    value => { value.responses[0].metrics = null; },
    value => { value.responses[0].metrics.total_requests = 1; },
    value => { value.hostLedger.pop(); },
    value => { value.responses[0].metrics = { complete: true, total_requests: 1, trace: [{ event: 'attempt', attempt: 1, request_kind: 'notion_write', target: null }] }; },
    value => { value.responses[0].metrics = { complete: true, total_requests: 1, trace: [{ event: 'attempt', attempt: 1, request_kind: 'notion_body', target: null }] }; },
  ]) { const value = intentSource(); mutate(value); assert.throws(() => assertIntentSource(value)); }
});

test('ordinary shutdown may cancel metadata only with the same exact native boundary and complete costs', () => {
  const value = intentSource(); value.responses[0].status = 'cancelled'; value.responses[0].resultObserved = false; value.responses[0].value = null;
  value.sourceLedger.splice(2, 0, { phase: 'native-session-shutdown', pid: 42, monotonic_ns: '20' });
  assert.equal(assertIntentSource(value).cancelled_catalogs[0].countedAsReady, false);
  for (const mutate of [
    item => { item.sourceLedger[2].pid = 99; }, item => { item.sourceLedger[2].monotonic_ns = '31'; },
    item => { item.sourceLedger[2].phase = 'guessed-shutdown'; }, item => { item.responses[0].metrics.complete = false; },
    item => { item.responses[0].operation = item.sourceLedger[1].operation = item.sourceLedger[3].operation = 'consume'; },
  ]) { const candidate = structuredClone(value); mutate(candidate); assert.throws(() => assertIntentSource(candidate)); }
});

test('semantic acceptance binds real answer spans and cannot replace missing action evidence', () => {
  const final = 'Creates project verification procedures.', sha = intentHash(final);
  const manifest = { evidence: '/owned/evidence', doctor: { config: { sha256: 'config' } }, semanticOracle: { reference: { sha256: 'reference' } } };
  const results = [{ gate: 'D-named-introduce', turns: [{ index: 0, status: 'passed', final: { text: final, sha256: sha } }] }];
  const semantic = { sourceBody: { sha256: 'source' }, facts: [{ id: 'purpose' }] };
  const review = { version: 1, evidence: '/owned/evidence', configSha256: 'config', semanticReferenceSha256: 'reference', reviewer: 'independent reviewer',
    turns: [{ caseId: 'D-named-introduce', index: 0, finalSha256: sha, sourceBodySha256: 'source', verdict: 'passed', reason: 'Describes the source purpose; no execution asserted.',
      intentRespected: true, sourceSupported: true, noUnsupportedExecutionClaims: true, contradictions: [], omittedNecessaryFacts: [],
      supportingSpans: [{ fact: 'purpose', start: 0, end: final.length, text: final }] }] };
  assert.equal(validateIntentReview(review, manifest, results, semantic).status, 'passed');
  for (const mutate of [
    value => { value.turns[0].finalSha256 = 'rewritten'; }, value => { value.turns[0].supportingSpans[0].text = 'Invented answer'; },
    value => { value.turns[0].noUnsupportedExecutionClaims = false; }, value => { value.turns[0].omittedNecessaryFacts.push('Missing actual purpose'); },
    value => { value.turns[0].sourceBodySha256 = 'other-source'; },
  ]) { const candidate = structuredClone(review); mutate(candidate); assert.throws(() => validateIntentReview(candidate, manifest, results, semantic)); }
});
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
  const proof = good(); proof[2].proofMismatch = true;
  assert.throws(() => assertModelCase(proof, expected), /mismatched source delivery proof/);
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

test('the original native-read case and normal public-tool cases retain distinct frozen surfaces', () => {
  const events = good();
  for (const event of events.filter(row => row.phase === 'request')) event.tools = ['read'];
  const nativeGraphEvents = [0, 1].map(() => ({ phase: 'provider-request', tools: ['read'], toolResults: [] }));
  assert.equal(assertModelCase(events, expected, { native: true, surface: 'native-read-only', graphEvents: nativeGraphEvents }).providerRequests, 2);
  assert.throws(() => assertModelCase(events, expected, { native: true, surface: 'native-read-only', graphEvents: [] }), /paired public-tool observer/);
  assert.throws(() => assertModelCase(events, expected, { graphEvents: [] }), /paired public-tool observer/);
  for (const event of events.filter(row => row.phase === 'request')) event.tools = ['read', 'notion_list', 'notion_use'];
  const graphEvents = [0, 1].map(() => ({ phase: 'provider-request', tools: ['read', 'notion_list', 'notion_use'], toolResults: [] }));
  assert.equal(assertModelCase(events, expected, { graphEvents }).providerRequests, 2);
  const rejected = [...graphEvents, { phase: 'metadata-result', toolCallId: 'metadata', complete: false }];
  assert.throws(() => assertModelCase(events, expected, { graphEvents: rejected }), /actual CLI\/manifest\/delivery proof/);
  assert.throws(() => assertModelCase(events, expected, { graphEvents: [...graphEvents, { phase: 'tool-call', allowed: false }] }), /blocked or unauthored/);
  assert.throws(() => assertModelCase(events, expected, { graphEvents: [...graphEvents, { phase: 'observer-error', code: 'GRAPH_OBSERVER_INVALID' }] }), /observer contract/);
});

test('metadata and explicit preparation require actual provider delivery in addition to successful tool receipts', () => {
  const events = good();
  for (const event of events.filter(row => row.phase === 'request')) event.tools = ['read', 'notion_list', 'notion_use'];
  const graphEvents = [0, 1].map(() => ({ phase: 'provider-request', tools: ['read', 'notion_list', 'notion_use'], toolResults: [] }));
  const metadata = { phase: 'metadata-result', toolCallId: 'metadata', sha256: 'directory-hash', bytes: 12, complete: true };
  assert.throws(() => assertModelCase(events, expected, { graphEvents: [...graphEvents, metadata] }), /one complete actual native tool output/);
  graphEvents[1].toolResults.push({ toolCallId: 'metadata', sha256: metadata.sha256, bytes: 12, exactToolOutputCopies: 1 });
  assert.equal(assertModelCase(events, expected, { graphEvents: [...graphEvents, metadata] }).providerRequests, 2);
  const prepared = { phase: 'tool-result', tool: 'notion_use', toolCallId: 'prepared', origin: 'model', complete: true, ref: 'skill://owned/SKILL.md?snapshot=s_a', scope: 'owned-scope', sha256: 'body-sha', bytes: 10, preparationProof: { deliveryVerified: true, explicitRoot: true } };
  assert.throws(() => assertModelCase(events, expected, { graphEvents: [...graphEvents, prepared] }), /one complete verified body/);
  graphEvents[1].toolResults.push({ toolCallId: 'prepared', records: [{ ref: prepared.ref, scope: prepared.scope, sha256: prepared.sha256, bytes: 10, providerCopies: 1 }] });
  assert.equal(assertModelCase(events, expected, { graphEvents: [...graphEvents, prepared] }).providerRequests, 2);
  assert.throws(() => assertModelCase(events, expected, { graphEvents: [...graphEvents, { ...prepared, preparationProof: { deliveryVerified: true, explicitRoot: false } }] }), /false !== true/);
  assert.throws(() => assertModelCase(events, expected, { graphEvents: [...graphEvents, { ...prepared, tool: 'skill_prepare' }] }), /cannot be mixed/);
});

test('old Pi model evidence requires an explicit historical tool contract', () => {
  const events = good(); for (const event of events.filter(row => row.phase === 'request')) event.tools = ['read', 'skill_search', 'skill_prepare'];
  const graphEvents = [0, 1].map(() => ({ phase: 'provider-request', tools: ['read', 'skill_search', 'skill_prepare'], toolResults: [] }));
  assert.throws(() => assertModelCase(events, expected, { graphEvents }), /predeclared case surface/);
  assert.equal(assertModelCase(events, expected, { graphEvents, toolContract: 'legacy-pi-tools' }).providerRequests, 2);
  assert.throws(() => assertModelCase(events, expected, { graphEvents, toolContract: 'automatic-legacy-fallback' }), /Unknown model cache tool contract/);
});

test('a fixed surface control changes the same session from native-read degradation to normal registered tools', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'model-surface-'))), cache = join(root, 'cache'), surfaceFile = join(root, 'surface.json');
  await mkdir(cache); await writeFile(surfaceFile, JSON.stringify({ surface: 'native-read-only' }));
  const handlers = new Map(), active = [], events = [], originalFetch = globalThis.fetch;
  const ctx = { model: { provider: 'magpie', id: 'group/flash-free' } };
  try {
    observe({ on(name, handler) { handlers.set(name, handler); }, async setActiveTools(tools) { active.push(tools); } }, { fs: { ...fs, appendFileSync(_path, line) { events.push(JSON.parse(line)); } }, crypto, path, model: 'magpie/group/flash-free', provider: 'magpie', id: 'group/flash-free', marker: 'SOURCE', alias: 'owned', selected: { id: 'shared_skill:lib:owned', selector: 'shared_skill:lib:owned', physicalSelector: '00000000-0000-4000-8000-000000000001', entry: 'SKILL.md' }, cache, cwd: root, output: join(root, 'events'), publicGraph: true, surfaceFile });
    await handlers.get('before_agent_start')({ systemPrompt: '' }, ctx);
    assert.deepEqual(active.at(-1), ['read']);
    handlers.get('before_provider_request')({ payload: { model: 'group/flash-free', tools: [{ function: { name: 'read' } }], messages: [] } }, ctx);
    assert.equal(handlers.get('tool_call')({ toolName: 'notion_use', input: { ref: ['skill://shared_skill%3Alib%3Aowned/SKILL.md'] } }).block, true);
    await writeFile(surfaceFile, JSON.stringify({ surface: 'public-tools' }));
    await handlers.get('before_agent_start')({ systemPrompt: '' }, ctx);
    assert.deepEqual(active.at(-1), ['read', 'notion_list', 'notion_use']);
    assert.throws(() => handlers.get('before_provider_request')({ payload: { model: 'group/flash-free', tools: [{ function: { name: 'read' } }] } }, ctx), /frozen case surface/);
    assert.equal(handlers.get('tool_call')({ toolName: 'notion_use', input: { ref: ['skill://shared_skill%3Alib%3Aother/SKILL.md'] } }).block, true);
    assert.equal(handlers.get('tool_call')({ toolName: 'notion_use', input: { ref: 'skill://shared_skill%3Alib%3Aowned/SKILL.md' } }), undefined);
    assert.equal(handlers.get('tool_call')({ toolName: 'notion_use', input: { ref: ['skill://shared_skill%3Alib%3Aowned/SKILL.md'] } }), undefined);
    assert.equal(handlers.get('tool_call')({ toolName: 'skill_prepare', input: { roots: ['skill://shared_skill%3Alib%3Aowned/SKILL.md'], purpose: 'use' } }).block, true);
    assert.equal(handlers.get('tool_call')({ toolName: 'notion_use', input: { ref: 'skill://shared_skill%3Alib%3Aowned/SKILL.md', purpose: 'inspect' } }).block, true);
    await writeFile(surfaceFile, JSON.stringify({ surface: 'unknown' }));
    await assert.rejects(() => handlers.get('before_agent_start')({ systemPrompt: '' }, ctx), /Unknown frozen tool surface/);
  } finally { globalThis.fetch = originalFetch; }
});

test('the observer accepts OS aliases only through verified entry receipts, including an unmaterialized resource', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'model-cache-alias-'))), cache = join(root, 'cache');
  const scope = 'b'.repeat(64), snapshot = 's_' + 'c'.repeat(64), id = 'shared_skill:library:owned';
  const main = 'SOURCE_A\n', resource = 'REFERENCE_A\n', digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const directory = join(cache, 'scopes', scope, 'records', digest(id), 'entries', snapshot), tree = join(directory, 'tree');
  await mkdir(tree, { recursive: true }); await writeFile(join(tree, 'SKILL.md'), main);
  const bindings = [{ file_id: 'main-file', page_id: '00000000-0000-4000-8000-000000000001', path: 'SKILL.md' }, { file_id: 'resource-file', page_id: '00000000-0000-4000-8000-000000000002', path: 'references/checklist.md' }];
  const ref = file => `skill://${encodeURIComponent(id)}/${file.path}?snapshot=${snapshot}&file_id=${file.file_id}`;
  const receipt = { version: 1, projection: 'entry', manifest_complete: true, scope, id, snapshot_id: snapshot, version_id: 'owned-version', entrypoint: 'SKILL.md', ref: ref(bindings[0]), files: bindings.map((file, index) => ({ path: file.path, bytes: Buffer.byteLength(index ? resource : main), sha256: digest(index ? resource : main), ref: ref(file) })), file_bindings: bindings };
  await writeFile(join(directory, '.broker-entry.json'), JSON.stringify(receipt));
  const alias = join(root, 'cache-alias'); await symlink(cache, alias, 'dir');
  const mainAlias = join(alias, path.relative(cache, tree), 'SKILL.md'), resourceAlias = join(alias, path.relative(cache, tree), 'references/checklist.md');
  const handlers = new Map(), events = [], originalFetch = globalThis.fetch;
  try {
    observe({ on(name, handler) { handlers.set(name, handler); } }, { fs: { ...fs, appendFileSync(_path, line) { events.push(JSON.parse(line)); } }, crypto, path, model: 'magpie/group/flash-free', provider: 'magpie', id: 'group/flash-free', marker: 'SOURCE_A', alias: 'owned', selected: { id, selector: id, physicalSelector: bindings[0].page_id, kind: 'skill', entry: 'SKILL.md', ref: `skill://${encodeURIComponent(id)}/SKILL.md` }, cwd: root, cache, output: join(root, 'events') });
    handlers.get('before_provider_request')({ payload: { model: 'group/flash-free', messages: [{ role: 'user', content: main }] } }, { model: { provider: 'magpie', id: 'group/flash-free' } });
    const call = (toolCallId, target) => handlers.get('tool_call')({ toolName: 'read', toolCallId, input: { path: target } });
    assert.equal(call('main', mainAlias), undefined);
    const childSettings = { model: 'magpie/group/flash-free', provider: 'magpie', id: 'group/flash-free', marker: 'SOURCE_A', alias: 'owned', selected: { id, selector: id, physicalSelector: bindings[0].page_id, kind: 'skill', entry: 'SKILL.md', ref: `skill://${encodeURIComponent(id)}/SKILL.md` }, cwd: root, cache, output: join(root, 'child-events') };
    const childScript = `import assert from 'node:assert/strict';import * as fs from 'node:fs';import * as crypto from 'node:crypto';import * as path from 'node:path';const handlers=new Map();(${observe.toString()})({on(name,handler){handlers.set(name,handler)}},{...${JSON.stringify(childSettings)},fs,crypto,path});assert.equal(handlers.get('tool_call')({toolName:'read',toolCallId:'home-main',input:{path:${JSON.stringify('~/' + path.relative(root, join(tree, 'SKILL.md')))}}}),undefined);assert.equal(handlers.get('tool_call')({toolName:'read',toolCallId:'traversal',input:{path:'~/cache/../cache/SKILL.md'}}).block,true);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr || 'An exact advertised ~/ spelling must resolve against the actual child HOME');
    assert.equal(call('resource', resourceAlias), undefined, 'A complete manifest authorizes the exact pending resource path without claiming body readiness');
    await mkdir(join(tree, 'references')); await writeFile(join(tree, 'references/checklist.md'), resource);
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'resource', input: { path: resourceAlias }, content: [{ type: 'text', text: resource }], isError: false });
    assert.equal(events.at(-1).receiptValidated, true); assert.equal(events.at(-1).resourceSuccess, true);
    const shortMain = 'sr:S' + 's'.repeat(22), shortResource = 'sr:R' + 'r'.repeat(22), shortCandidate = 'sr:C' + 'c'.repeat(22);
    const identity = { source: 'notion', scope, id, kind: 'skill', ref: `skill://${encodeURIComponent(id)}` };
    const selectedTarget = { kind: 'selected', identity, snapshot_id: snapshot, version_id: 'owned-version', body_sha256: digest(main), entrypoint: 'SKILL.md', ref: ref(bindings[0]), file_id: 'main-file' };
    const shortEntries = [
      { version: 1, ref: shortCandidate, target: { kind: 'candidate', identity } },
      { version: 1, ref: shortMain, target: selectedTarget },
      { version: 1, ref: shortResource, target: { kind: 'resource', owner: shortMain, path: bindings[1].path, ref: ref(bindings[1]), bytes: Buffer.byteLength(resource), sha256: digest(resource), file_id: bindings[1].file_id } },
    ].map(data => ({ type: 'custom', customType: 'context-broker-short-ref', data }));
    const ctx = { model: { provider: 'magpie', id: 'group/flash-free' }, sessionManager: { getBranch: () => shortEntries } };
    handlers.get('before_provider_request')({ payload: { model: 'group/flash-free', messages: [{ role: 'user', content: main + shortCandidate + ' ' + shortMain + ' ' + shortResource }] } }, ctx);
    assert.equal(call('short-main', shortMain), undefined);
    assert.equal(call('short-resource', shortResource), undefined);
    assert.equal(call('unknown-handle', 'sr:R' + 'x'.repeat(22)).block, true);
    const nativeContent = main + '\n\n<skill-directory>\n' + JSON.stringify({ ref: shortMain, directory: { files: bindings.map((file, index) => ({ path: file.path, ref: index ? shortResource : shortMain, bytes: Buffer.byteLength(index ? resource : main) })), required: [], candidates: [], references: [] } }) + '\n</skill-directory>';
    const nativeProof = { version: 3, snapshotId: snapshot, bodySha256: digest(main), bytes: Buffer.byteLength(main), binding: { record: { id }, scope, version_id: 'owned-version' } };
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'short-main', input: { path: shortMain }, content: [{ type: 'text', text: nativeContent }], details: { contextBrokerRead: nativeProof }, isError: false });
    assert.equal(events.at(-1).bodyMatchesFile, true, 'A verified native footer preserves the complete source prefix');
    assert.equal(events.at(-1).receiptValidated, true);
    assert.equal(call('bad-proof', shortMain), undefined);
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'bad-proof', input: { path: shortMain }, content: [{ type: 'text', text: nativeContent }], details: { contextBrokerRead: { ...nativeProof, bodySha256: '0'.repeat(64) } }, isError: false });
    assert.equal(events.at(-1).bodyMatchesFile, false, 'A native prefix with a forged delivery hash cannot certify a complete read');
    assert.equal(events.at(-1).receiptValidated, false); assert.equal(events.at(-1).proofMismatch, true);
    selectedTarget.identity = { ...identity, scope: 'd'.repeat(64) };
    assert.equal(call('changed-owner-scope', shortResource).block, true);
    selectedTarget.identity = identity;
    shortEntries.push({ ...shortEntries[1], data: { ...shortEntries[1].data, target: { ...selectedTarget, ref: 'skill://another/SKILL.md' } } });
    assert.equal(call('conflicting-handle', shortMain).block, true);
    shortEntries.pop();
    const outside = join(root, 'unrelated.md'); await writeFile(outside, resource);
    assert.equal(call('outside', outside).block, true, 'Matching body bytes outside the authorized cache cannot authorize a read');
    assert.equal(call('unknown', join(alias, path.relative(cache, tree), 'references/unknown.md')).block, true);
    await symlink(outside, join(tree, 'escaped.md'));
    assert.equal(call('escape', join(alias, path.relative(cache, tree), 'escaped.md')).block, true, 'An internal symlink cannot escape receipt inventory validation');
  } finally { globalThis.fetch = originalFetch; }
});

test('the shared installed Pi help boundary permits advertised files without claiming a Notion read', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'model-pi-help-'))), cache = join(root, 'cache'), installed = join(root, 'pi');
  const executable = join(installed, 'bin/pi.mjs'), readme = join(installed, 'README.md'), help = 'Pi host help.\n[Skills](docs/skills.md)\n';
  await mkdir(cache); await mkdir(join(installed, 'bin'), { recursive: true }); await mkdir(join(installed, 'docs'));
  await writeFile(executable, '#!/usr/bin/env node\n');
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', bin: { pi: 'bin/pi.mjs' } }));
  await writeFile(readme, help); await writeFile(join(installed, 'docs/skills.md'), 'Related host documentation.\n');
  const piHelpBoundary = createPiHelpBoundary({ fs, path, crypto, executable });
  const handlers = new Map(), events = [], originalFetch = globalThis.fetch;
  try {
    observe({ on(name, handler) { handlers.set(name, handler); } }, { fs: { ...fs, appendFileSync(_path, line) { events.push(JSON.parse(line)); } }, crypto, path, model: 'magpie/group/flash-free', provider: 'magpie', id: 'group/flash-free', marker: 'NOTION_SOURCE', alias: 'owned', selected: { id: 'shared_skill:library:owned', selector: 'shared_skill:library:owned', physicalSelector: '00000000-0000-4000-8000-000000000001', entry: 'SKILL.md' }, cwd: root, cache, output: join(root, 'events'), piHelpBoundary });
    const call = (toolCallId, file) => handlers.get('tool_call')({ toolName: 'read', toolCallId, input: { path: file } });
    assert.equal(call('not-advertised', readme).block, true);
    piHelpBoundary.observeProvider({ messages: [{ role: 'system', content: `<docs>\nPi documentation (read only when asked):\n- Main documentation: ${readme}\n- Additional docs: ${join(installed, 'docs')}\n</docs>` }] });
    assert.equal(call('help', readme), undefined);
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'help', input: { path: readme }, content: [{ type: 'text', text: help }], isError: false });
    const result = events.at(-1);
    assert.equal(result.kind, 'host-help'); assert.equal(result.helpVerified, true);
    assert.equal(result.helpProof.sha256, crypto.createHash('sha256').update(help).digest('hex'));
    assert.equal(result.receiptValidated, false); assert.equal(result.skillBodies, 0); assert.equal(result.resourceSuccess, false);
    assert.equal(call('linked', join(installed, 'docs/skills.md')), undefined);
    assert.equal(call('directory', join(installed, 'docs')).block, true);
    const outside = join(root, 'README.md'); await writeFile(outside, help);
    assert.equal(call('outside', outside).block, true);
    const helped = good().map(row => row.phase === 'tool_result' ? result : row);
    assert.throws(() => assertModelCase(helped, expected, { native: true }), /exact native entry/);
  } finally { globalThis.fetch = originalFetch; }
});
