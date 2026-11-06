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
import { dailyRouteContract, verifyDailyRouteState, verifyDailyRouteEvidence } from './verify-skill-graph-contract.mjs';
import { createOwnedGraphProject, inspectOwnedGraphProject } from './notion-skill-graph-project.mjs';
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

test('daily C/D keeps the frozen cases and budgets while explicitly selecting flash with high thinking', () => {
  const config = { ...intentConfig(), modelContract: 'daily-route-v1', model: 'magpie/group/flash', thinkingLevel: 'high', rpcTimeoutMs: 300000 };
  assert.equal(validateIntentConfiguration(config), config);
  const selected = intentRunner.selectIntentCases(config, 'C-introduce');
  assert.equal(selected.plannedBudget.maxSubmissions, 3); assert.equal(selected.plannedBudget.timeoutMsPerSubmission, 300000);
  for (const change of [{ modelContract: 'unknown' }, { model: 'magpie/group/worker' }, { thinkingLevel: 'off' },
    { rpcTimeoutMs: 120000 }, { previousFailures: ['old-free-failure'] }, { workerAuthorization: {} }, { fallback: 'allowed' }])
    assert.throws(() => validateIntentConfiguration({ ...config, ...change }));
  const undeclared = { ...intentConfig(), model: 'magpie/group/flash' };
  assert.throws(() => validateIntentConfiguration(undeclared), 'Legacy validation cannot silently adopt daily routing');
});

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

const readyConfig = () => ({ ...intentConfig(), phase: 'SC06-discovery-prototype',
  discoveryExperiment: { version: 1, mode: 'full-cards' },
  discoveryStartup: { mode: 'ready-directory', timeoutMs: 60000 } });

test('ready-directory selection shares the original 1200-second arm wall with setup', () => {
  const config = readyConfig(), scope = intentRunner.selectIntentCases(config, 'D-early');
  assert.equal(scope.plannedBudget.maxScheduledPromptMs, 1200000);
  assert.equal(scope.plannedBudget.maxArmWallMs, 1200000);
  assert.deepEqual(scope.plannedBudget.directorySetup, { perCaseMs: 60000, maxCases: 3,
    maxSetupMs: 180000, includedInArmWall: true });
  assert.equal(scope.plannedBudget.timeoutMsPerSubmission, 300000);
  assert.deepEqual(scope.notRunCases.map(item => item.id), ['C-introduce']);
  assert.equal(intentRunner.selectIntentCases(intentConfig(), 'D-early').plannedBudget.maxArmWallMs, undefined,
    'The existing cold experiment is not silently relabelled or changed');
});

test('ready-directory opt-in rejects incomplete configuration and never expands task budgets', () => {
  for (const mutate of [
    value => { delete value.discoveryExperiment; value.phase = 'early-feedback-not-formal-SC21'; },
    value => { value.discoveryStartup.mode = 'preload-body'; },
    value => { value.discoveryStartup.timeoutMs = 60001; },
    value => { value.discoveryStartup.armTimeoutMs = 1380000; },
    value => { value.discoveryStartup.target = 'private-ref'; },
  ]) { const value = readyConfig(); mutate(value); assert.throws(() => validateIntentConfiguration(value)); }
  for (const selected of [undefined, 'C-introduce']) assert.throws(() => intentRunner.selectIntentCases(readyConfig(), selected));
  const cold = readyConfig(); delete cold.discoveryStartup;
  assert.notEqual(intentRunner.discoveryExperimentIdentity(readyConfig()).comparisonSha256,
    intentRunner.discoveryExperimentIdentity(cold).comparisonSha256, 'Ready and cold strata have distinct frozen inputs');
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

test('daily intent evaluator binds each turn to actual state, wire effort and routed response usage', () => {
  const input = introInput();
  input.modelProfile = dailyRouteContract({ modelContract: 'daily-route-v1', model: 'magpie/group/flash', thinkingLevel: 'high', rpcTimeoutMs: 300000 });
  input.observation.unshift({ phase: 'model-state', state: { model: { provider: 'magpie', id: 'group/flash' }, thinkingLevel: 'high' } });
  const providers = input.observation.filter(event => event.phase === 'provider-request');
  providers.forEach((request, index) => {
    Object.assign(request, { sequence: index + 1, model: input.modelProfile.model, reasoningEffort: 'high', observedPayloadSha256: String(index + 1).repeat(64) });
    input.observation.push({ phase: 'provider-transport-start', providerSequence: request.sequence, wireModel: 'group/flash',
      reasoningEffort: 'high', observedPayloadSha256: request.observedPayloadSha256 },
    { phase: 'model-response', providerSequence: request.sequence, providerPayloadSha256: request.observedPayloadSha256,
      provider: 'magpie', model: 'group/flash', responseModel: 'controlled/backend-v1', stopReason: 'stop',
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } });
  });
  assert.equal(assertIntentTurn(input).modelEvidence.requests, 2);
  for (const mutate of [value => { value.observation[0].state.thinkingLevel = 'off'; },
    value => { value.observation.find(event => event.phase === 'provider-transport-start').reasoningEffort = null; },
    value => { value.observation.find(event => event.phase === 'model-response').responseModel = null; },
    value => { value.observation.find(event => event.phase === 'model-response').usage = null; },
    value => { value.observation.push({ phase: 'tool-result', complete: false, errorCode: 'SHORT_REF_INVALID' }); }]) {
    const invalid = structuredClone(input); mutate(invalid); assert.throws(() => assertIntentTurn(invalid));
  }
});

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

test('product validation errors keep the complete task failed even after a later correct read', () => {
  const value = introInput(), requested = 'sr:C' + 'c'.repeat(22) + '/SKILL.md';
  value.observation.splice(2, 0,
    { phase: 'tool-call', tool: 'read', allowed: true, category: 'invalid-short-ref', input: requested },
    { phase: 'tool-result', tool: 'read', complete: false, requested, isError: true,
      error: 'context-broker activation failed (SHORT_REF_INVALID)', errorCode: 'SHORT_REF_INVALID', validationErrorMatched: true });
  assert.throws(() => assertIntentTurn(value), /Every actual selected output must be complete/);
});

test('ready-directory task cannot pass using a pending first provider or an internal ready label', () => {
  const value = introInput();
  value.observation.unshift({ phase: 'catalog', stage: 'before_provider_request', state: 'pending', skills: [] });
  assert.equal(assertIntentTurn(value).status, 'passed', 'Original cold pending behavior is unchanged');
  value.discoveryStartup = readyConfig().discoveryStartup;
  assert.throws(() => assertIntentTurn(value), /ready.*first provider|first provider.*ready/i);
  value.observation[0] = { phase: 'catalog-before-agent-start', state: 'ready', skills: [] };
  assert.throws(() => assertIntentTurn(value), /ready.*first provider|first provider.*ready/i);
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
});

test('ordinary restored reuse can start with pending metadata only with its complete selected body', () => {
  const input = () => {
    const value = introInput();
    value.followup = true; value.intent = 'reuse-introduction'; value.newResponses = [];
    value.discoveryStartup = readyConfig().discoveryStartup;
    value.turnObservation = [
      { phase: 'catalog', stage: 'before_provider_request', state: 'pending', skills: [] },
      structuredClone(value.observation[3]),
      { phase: 'provider-transport-response', status: 200 },
      { phase: 'assistant-final', success: true, text: 'Reuses the inspected verification procedure.' },
    ];
    return value;
  };
  assert.equal(assertIntentTurn(input()).status, 'passed');
  for (const mutate of [
    value => { value.turnObservation[1].contents = []; },
    value => { value.turnObservation[1].contents[0].bytes = 99; },
    value => { value.turnObservation[1].contents[0].sha256 = 'c'.repeat(64); },
    value => { value.turnObservation[1].contents[0].snapshot = 's_other'; },
    value => { value.turnObservation[1].contents[0].scope = 'other-scope'; },
    value => { value.turnObservation[1].contents[0].ownerId = 'other-owner'; },
    value => { value.turnObservation[1].contents.push({ ...value.turnObservation[1].contents[0] }); },
    value => { value.newResponses = [{ operation: 'consume' }]; },
    value => { value.newResponses = [{ operation: 'read' }]; },
    value => { value.turnObservation[0].state = 'ready'; },
  ]) { const value = input(); mutate(value); assert.throws(() => assertIntentTurn(value)); }
  const delayed = input();
  delayed.turnObservation.splice(1, 0, { ...delayed.turnObservation[1], contents: [] });
  assert.throws(() => assertIntentTurn(delayed), /before the first provider/);
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

const pendingChatSource = () => {
  const value = intentSource();
  const records = Array.from({ length: 298 }, (_, index) => ({ id: `skill-${index}`, name: `Skill ${index}`,
    description: `Description ${index}`, ref: `skill://skill-${index}/SKILL.md` }));
  value.catalogRecords = structuredClone(records.slice(0, 74)); value.metadataOnly = true;
  value.observation = [{ phase: 'catalog', stage: 'before_provider_request', state: 'pending', skills: [], routers: [] }];
  value.responses[0].value = { scope: 'scope', records, count: records.length, coverage: { method: 'explicit_database',
    exhaustive: true, failed_sources: [], search_index_limited: false } };
  value.responses[0].metrics = { complete: true, total_requests: 1, trace: [{ event: 'attempt', attempt: 1,
    request_kind: 'notion_metadata', request_bytes: 237, response_bytes: 721014, outcome: 'success' }] };
  value.responses.push({ transport: 'sdk', operation: 'list', requestId: 'two', status: 'cancelled', value: null,
    sdk_started: true, metrics_observed: true, resultObserved: false,
    metrics: { complete: true, total_requests: 1, trace: [{ event: 'attempt', attempt: 1, request_kind: 'notion_metadata',
      request_bytes: 0, response_bytes: null, outcome: 'cancelled' }] } });
  value.sourceLedger.splice(-1, 0,
    { phase: 'sdk-start', requestId: 'two', operation: 'list', pid: 42, monotonic_ns: '40' },
    { phase: 'native-session-shutdown', pid: 42, monotonic_ns: '50' },
    { phase: 'sdk-end', requestId: 'two', operation: 'list', pid: 42, monotonic_ns: '60' });
  return value;
};
const completeDefaultSource = () => {
  const value = pendingChatSource(), result = value.responses[1];
  result.status = 'completed'; result.resultObserved = true;
  result.value = { scope: 'scope', records: structuredClone(value.catalogRecords), count: 74,
    capability_directory: true, view: { id: 'default-view' }, view_selection: 'first',
    coverage: { method: 'explicit_view', exhaustive: true, failed_sources: [], search_index_limited: false } };
  result.metrics.trace[0] = { ...result.metrics.trace[0], outcome: 'success', response_bytes: 100 };
  value.observation[0].state = 'ready';
  return value;
};

const startupInput = () => {
  const value = completeDefaultSource();
  value.responses[1].value.view.name = 'Default';
  value.catalog = { scope: value.scope, records: structuredClone(value.catalogRecords), view: { id: 'default-view', name: 'Default' } };
  value.sourceLedger = value.sourceLedger.filter(event => !['sdk-observer-end', 'native-session-shutdown'].includes(event.phase));
  for (const event of value.sourceLedger.filter(event => event.phase === 'sdk-end'))
    Object.assign(event, { status: 'completed', metricsComplete: true, resultObserved: true });
  return { ...value, observation: [], handled: { agentInvoked: false, status: 'completed' }, pid: 42,
    statusFrame: { type: 'extension_ui_request', method: 'notify', notifyType: 'info', message: 'notion: Default (default-view) · 74 Skill/Router · first' } };
};

test('ready-directory barrier pairs local status with complete same-scope Default SDK metadata', () => {
  const value = startupInput(), ready = intentRunner.inspectDiscoveryStartup(value);
  assert.equal(ready.state, 'ready'); assert.deepEqual(ready.defaultRequestIds, ['two']);
  assert.equal(ready.httpAttempts, 2); assert.equal(ready.requestBytes, 237); assert.equal(ready.responseBytes, 721114);
  assert.equal(ready.modelVisibility, 'not_yet_observed');
  const missing = structuredClone(value); missing.responses.pop(); missing.sourceLedger.pop();
  assert.equal(intentRunner.inspectDiscoveryStartup(missing).state, 'pending', 'A local ready message cannot replace the unfinished SDK operation');
  const unpublished = structuredClone(value); unpublished.statusFrame.message = 'Notion Views: no enabled Notion sources';
  assert.equal(intentRunner.inspectDiscoveryStartup(unpublished).state, 'pending', 'Source completion alone is not the native ready state');
  const ordinary = structuredClone(value); ordinary.responses.pop(); ordinary.sourceLedger.splice(-2);
  ordinary.responses[0].value.records = ordinary.catalogRecords; ordinary.responses[0].value.count = 74;
  assert.equal(intentRunner.inspectDiscoveryStartup(ordinary).state, 'pending', 'Even a complete 74-row ordinary inventory is not a Default View');
  value.responses[0].metrics.trace[0].response_bytes = null;
  assert.equal(intentRunner.inspectDiscoveryStartup(value).responseBytes, null, 'Unknown bytes cannot become zero');
});

test('ready-directory rejects partial, failed, cancelled, foreign and fabricated setup evidence', () => {
  for (const mutate of [
    value => { value.responses[1].value.coverage.exhaustive = false; },
    value => { value.responses[1].value.coverage.failed_sources = [{ id: 'source', code: 'DENIED' }]; },
    value => { value.responses[1].value.scope = 'other'; },
    value => { value.responses[0].value.scope = 'other'; },
    value => { value.responses[1].value.records[0].description = 'changed'; },
    value => { value.responses[1].value.records[0].ref = 'skill://different/SKILL.md'; },
    value => { value.responses[1].value.records[1] = value.responses[1].value.records[0]; },
    value => { value.responses[1].value.view.id = 'different'; },
    value => { value.responses[1].value.view_selection = 'explicit'; },
    value => { value.responses[1].value.count--; },
    value => { value.responses[0].value.coverage.search_index_limited = true; },
    value => { value.responses[1].status = 'cancelled'; value.responses[1].value = null; },
    value => { value.sourceLedger.at(-1).status = 'failed'; },
    value => { value.responses[1].resultObserved = false; },
    value => { value.responses[1].metrics.complete = false; },
    value => { value.responses[1].metrics.total_requests++; },
    value => { value.responses[1].metrics.trace[0].request_kind = 'notion_body'; },
    value => { value.responses[1].metrics.trace[0].request_kind = 'notion_write'; },
    value => { value.sourceLedger[1].operation = 'consume'; },
    value => { value.sourceLedger.at(-1).pid = 99; },
    value => { value.sourceLedger.push({ phase: 'sdk-observer-error' }); },
    value => { value.sourceLedger.push({ phase: 'native-session-shutdown' }); },
    value => { value.sourceLedger.push({ phase: 'child-spawn', source: true }); },
    value => { value.handled.agentInvoked = true; },
    value => { value.statusFrame.type = 'assistant'; },
    value => { value.statusFrame.message += ' · partial'; },
    value => { value.statusFrame.message = 'notion: default View failed (DENIED) · first'; },
    value => { value.statusFrame.message = 'notion: no Views; empty default directory · first'; },
    value => { value.statusFrame.notifyType = 'error'; },
    value => { value.observation.push({ phase: 'native-input' }); },
    value => { value.observation.push({ phase: 'provider-transport-start' }); },
    value => { value.observation.push({ phase: 'project-read-result' }); },
  ]) { const value = startupInput(); mutate(value); assert.throws(() => intentRunner.inspectDiscoveryStartup(value)); }
});

test('ready-directory waits through native local commands without adding a user/model message', async () => {
  const value = startupInput(), seen = [], saved = []; let count = 0, clock = 0;
  const rpc = { frames: [], lifecycle: [{ event: 'spawn', pid: 42 }],
    command: async name => { seen.push(name); assert.ok(['get_messages', 'get_commands'].includes(name));
      return name === 'get_commands' ? { commands: [{ name: 'context-broker', source: 'extension' }] } : { messages: [] }; },
    prompt: async text => { seen.push(text); count++; rpc.frames.push({ ...value.statusFrame,
      message: count === 1 ? 'Notion Views: no enabled Notion sources' : value.statusFrame.message }); return value.handled; } };
  const result = await intentRunner.waitForDiscoveryReady({ rpc, catalog: value.catalog, armStartedMs: 0, setupStartedMs: 0,
    snapshot: async () => value, stop: async () => assert.fail('No shutdown before the admitted task'), savePoll: async poll => saved.push(poll),
    now: () => clock, pause: async ms => { clock += ms; } });
  assert.equal(result.status, 'ready'); assert.equal(result.polls.length, 2); assert.equal(result.elapsedMs, 250);
  assert.deepEqual(seen, ['get_commands', 'get_messages', '/context-broker view', '/context-broker view', 'get_messages']);
  assert.equal(saved.length, 2); assert.equal(result.setupProviderRequests, 0);
  rpc.command = async name => name === 'get_commands' ? { commands: [{ name: 'context-broker', source: 'extension' }] }
    : { messages: [{ role: 'user', content: 'preloaded greeting' }] };
  await assert.rejects(() => intentRunner.waitForDiscoveryReady({ rpc, catalog: value.catalog, armStartedMs: 0, setupStartedMs: 0,
    snapshot: async () => value, stop: async () => {}, savePoll: async () => {}, now: () => 0 }), /empty session/);
  rpc.command = async () => ({ commands: [] });
  await assert.rejects(() => intentRunner.waitForDiscoveryReady({ rpc, catalog: value.catalog, armStartedMs: 0, setupStartedMs: 0,
    snapshot: async () => value, stop: async () => {}, savePoll: async () => {}, now: () => 0 }), /command must be registered/);
  assert.equal(count, 2, 'An unavailable extension command cannot fall through to the model');
});

test('ready-directory timeout never submits a task and shares the shrinking arm allowance', async () => {
  assert.equal(intentRunner.discoveryAllowance({ armStartedMs: 0, stageStartedMs: 1199000, stageLimitMs: 60000, nowMs: 1199500 }), 500);
  assert.equal(intentRunner.discoveryAllowance({ armStartedMs: 0, stageStartedMs: 900000, stageLimitMs: 300000, nowMs: 950000 }), 250000);
  assert.throws(() => intentRunner.discoveryAllowance({ armStartedMs: 0, stageStartedMs: 1199000, stageLimitMs: 60000, nowMs: 1200000 }), { code: 'DISCOVERY_ARM_TIMEOUT' });
  assert.throws(() => intentRunner.discoveryAllowance({ armStartedMs: 0, stageStartedMs: 0, stageLimitMs: 60000, nowMs: 60000 }), { code: 'DISCOVERY_STAGE_TIMEOUT' });
  const value = startupInput(); value.statusFrame.message = 'Notion Views: no enabled Notion sources';
  let clock = 0, prompts = 0;
  const rpc = { frames: [], lifecycle: [{ event: 'spawn', pid: 42 }], command: async name => name === 'get_commands'
    ? { commands: [{ name: 'context-broker', source: 'extension' }] } : { messages: [] },
    prompt: async text => { assert.equal(text, '/context-broker view'); prompts++; rpc.frames.push(value.statusFrame); return value.handled; } };
  await assert.rejects(() => intentRunner.waitForDiscoveryReady({ rpc, catalog: value.catalog, armStartedMs: 0, setupStartedMs: 0,
    snapshot: async () => value, stop: async () => {}, savePoll: async () => {}, now: () => clock, pause: async () => { clock = 60000; } }),
  { code: 'DISCOVERY_STAGE_TIMEOUT' });
  assert.equal(prompts, 1, 'Polling timeout cannot create a model submission or retry');
});

test('failed ready-directory setup keeps source costs and proves zero model work only with a complete observer chain', () => {
  const setupIdentity = { sampleId: 'setup', clockId: 'clock' };
  const events = extra => {
    let previousSha256 = null;
    return [{ phase: 'observer_start' }, ...extra, { phase: 'observer_end', complete: true, errors: 0 }].map((event, index) => {
      const body = { ...event, ...setupIdentity, sequence: index + 1, previousSha256 };
      previousSha256 = intentHash(JSON.stringify(body)); return { ...body, eventSha256: previousSha256 };
    });
  };
  const result = intentRunner.summarizeDiscoveryCosts({ events: events([]), observation: [], setupIdentity });
  assert.equal(result.task, 'not_run'); assert.equal(result.modelHttpAttempts, 0); assert.equal(result.tokens, null);
  for (const phase of ['input', 'provider_request', 'tool_call'])
    assert.throws(() => intentRunner.summarizeDiscoveryCosts({ events: events([{ phase }]), observation: [], setupIdentity }), /hide model work/);
  for (const phase of ['provider-transport-error', 'authored-tool-call'])
    assert.throws(() => intentRunner.summarizeDiscoveryCosts({ events: events([]), observation: [{ phase }], setupIdentity }));
  const truncated = events([]); truncated.pop();
  assert.throws(() => intentRunner.summarizeDiscoveryCosts({ events: truncated, observation: [], setupIdentity }));
  const changed = events([]); changed[0].eventSha256 = '0'.repeat(64);
  assert.throws(() => intentRunner.summarizeDiscoveryCosts({ events: changed, observation: [], setupIdentity }));
});

test('ready-directory host finality failure stops the cohort even when source and cost ledgers closed', () => {
  const value = { sourceComplete: true, observation: [], result: { status: 'failed', error: { code: 'INTENT_EVIDENCE_FAILED' },
    directorySetup: { status: 'ready', firstProvider: { status: 'verified' } }, discoveryExperiment: { costStatus: 'complete' } } };
  assert.equal(intentRunner.discoveryTechnicalFailure(value), false, 'An independent task-behavior failure does not stop the other cases');
  value.result.hostFinality = { status: 'failed', error: { code: 'HOST_FINALITY_FAILED', message: 'Native close failed' } };
  assert.equal(intentRunner.discoveryTechnicalFailure(value), true, 'A later generic assertion cannot hide the terminal failure');
  assert.equal(value.result.hostFinality.error.code, 'HOST_FINALITY_FAILED');
});

// Execute the production case loop with local RPC/source boundaries. No copied
// loop, replacement selector, real host, provider or source is used. Actual file
// writes let the assertions inspect the persisted failure and not-run records.
async function driveIntentStopping(config, fault, inspect) {
  const root = await mkdtemp(join(tmpdir(), 'intent-stop-'));
  try {
    const evidenceRoot = join(root, 'evidence'), privateRoot = join(root, 'private');
    await Promise.all([mkdir(evidenceRoot), mkdir(privateRoot)]);
    config = { ...config, evidenceRoot, pi: { path: '/controlled/pi' }, candidate: { extension: '/controlled/broker/index.ts' },
      cliCommand: ['/controlled/node', '/controlled/ntn-skills.mjs'],
      project: { sha256: 'b4c48f279ec9d1895ab9e2cc5f91ff4fa6dd56743cdc83aa5b95e700b2a8495f' },
      privateOracle: { ...config.privateOracle, path: join(privateRoot, 'oracle.json'), semanticReference: { sha256: 'a'.repeat(64) } } };
    const executionScope = intentRunner.selectIntentCases(config, 'D-early'), profile = dailyRouteContract(config);
    const prompts = [], launches = [], stops = [], exercises = [], settings = new Map();
    const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
    const rows = async file => { try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
    const add = (file, row) => fs.promises.appendFile(file, JSON.stringify(row) + '\n');
    const state = { model: { provider: 'magpie', id: profile ? 'group/flash' : 'group/flash-free' }, thinkingLevel: profile ? 'high' : 'off' };
    const boundaries = { ...intentRunner, assert, join, basename: path.basename, dirname: path.dirname, pathToFileURL: value => ({ href: 'file://' + value }),
      mkdir, mkdtemp, realpath, readdir: fs.promises.readdir, readFile, writeFile, appendFile: fs.promises.appendFile,
      save, rows, json: async file => JSON.parse(await readFile(file, 'utf8')), hash: intentHash,
      root: path.resolve(import.meta.dirname, '..'), console: { log() {} }, dailyRouteContract, verifyDailyRouteState,
      createOwnedGraphProject, inspectOwnedGraphProject, verificationCliEnvironment: () => ({}), systemTempRoot: async () => root,
      intentDoctor: async () => ({ config, executionScope, oracle: { target: { scope: 'scope', logicalId: 'shared_skill:library:target' } },
        semantic: { sourceBody: { sha256: 'b'.repeat(64) } }, catalog: { records: [] },
        artifacts: { packageRoot: '/controlled/broker' }, host: { identity: '/controlled/pi' }, report: {} }),
      sourceObserver: async control => { const file = join(control, 'source.mjs'); await writeFile(file, ''); return file; },
      createGraphFallbackTraps: async (control, output) => { const ledger = join(output, 'fallback.jsonl'); await writeFile(ledger, ''); return { environment: {}, ledger }; },
      graphObserverModule: value => { settings.set(value.cwd, value); return 'export default () => {};'; },
      consumptionCostExtensionSource: () => 'export default () => {};',
      readConsumptionCostEvents: async () => ({ events: [], artifact: {} }), summarizeDiscoveryCosts: () => ({ complete: true }),
      withinDiscoveryBudget: operation => operation(),
      waitForDiscoveryReady: async () => ({ status: 'ready' }), assertReadyDiscoveryProvider: () => ({ status: 'verified' }),
      collectIntentResponses: async () => [], graphSourceAttribution: () => ({ attempts: [] }), graphSourceAccounting: () => ({}),
      collectSupplementaryRetainedProof: async () => ({ receipt: { status: 'not-configured' } }),
      assertIntentSource: input => {
        if (fault === 'source' && input.observation.some(row => row.caseId === 'D-named-introduce')) throw Object.assign(new Error('controlled source finality failure'), { code: 'SOURCE_OBSERVER_FAILED' });
        return { complete: true, fixtureLedgerRetained: true };
      },
      assertIntentTurn: input => {
        if (input.item.id === 'D-named-introduce' && !input.followup && ['source', 'observer', 'intent', 'model-route'].includes(fault)) {
          if (fault === 'model-route') verifyDailyRouteEvidence(profile, { states: [state], requests: [], transports: [], responses: [] });
          assert.fail('controlled ' + fault + ' turn failure');
        }
        return { status: 'passed', final: { success: true, text: 'Controlled complete final.' } };
      },
      retainedFileInventory: async () => [],
      retainGeneratedPlan: async ({ evidence }) => { await writeFile(join(evidence, 'generated-skill.md'), '`npm test`\n'); return { artifactStatus: 'complete-skill-files-retained', files: [{ evidencePath: 'generated-skill.md' }] }; },
      exerciseGeneratedProcedure: async (evidence, command) => { exercises.push({ evidence, command }); return { status: 'passed' }; },
      startRpc: async options => {
        const value = settings.get(options.cwd), caseId = path.basename(path.dirname(value.output));
        const processIndex = launches.filter(row => row.caseId === caseId).length + 1;
        launches.push({ caseId, processIndex, args: options.args, timeoutMs: options.timeoutMs });
        const frames = [], lifecycle = [{ event: 'spawn', pid: launches.length }];
        return { frames, lifecycle,
          command: async name => name === 'get_state' ? { ...state, ...(fault === 'model-state' && caseId === 'D-named-introduce' ? { thinkingLevel: 'off' } : {}), sessionFile: join(options.cwd, '..', 'sessions', 'actual-session.jsonl') } : { messages: [] },
          prompt: async text => {
            prompts.push({ caseId, processIndex, text });
            await add(value.output, { phase: 'native-input', caseId, textSha256: intentHash(text) });
            await add(join(path.dirname(value.output), 'source-processes.jsonl'), { phase: 'controlled-cost', caseId, submission: prompts.length, bytes: 91 });
            if (fault === 'observer' && caseId === 'D-named-introduce') await add(value.output, { phase: 'observer-error', caseId });
          },
          stop: async () => { stops.push({ caseId, processIndex }); lifecycle.push({ event: 'close', code: 143 });
            if (fault === 'host' && caseId === 'D-named-introduce' && processIndex === 1) throw new Error('controlled native close failure'); },
        };
      },
    };
    const run = Function(...Object.keys(boundaries), 'return (' + intentRunner.runIntentCases.toString() + ');')(...Object.values(boundaries));
    const manifest = await run('/controlled/config.json', 'D-early');
    assert.deepEqual(JSON.parse(await readFile(join(manifest.evidence, 'manifest.json'), 'utf8')), JSON.parse(JSON.stringify(manifest)));
    const results = await Promise.all(manifest.cases.map(item => boundaries.json(join(item.evidence, 'result.json'))));
    const costs = await Promise.all(manifest.cases.map(item => rows(join(item.evidence, 'source-processes.jsonl'))));
    await inspect({ manifest, results, prompts, launches, stops, exercises, costs });
  } finally {
    // The verification caller retains these synthetic fixtures before using Trash.
    console.log('Owned intent-stop fixture retained: ' + root);
  }
}

for (const fault of ['source', 'observer', 'host', 'model-state', 'model-route']) test('ordinary daily D stops later submissions after ' + fault + ' technical failure', async () => {
  const config = { ...intentConfig(), modelContract: 'daily-route-v1', model: 'magpie/group/flash', thinkingLevel: 'high', rpcTimeoutMs: 300000 };
  await driveIntentStopping(config, fault, ({ manifest, results, prompts, launches, costs }) => {
    assert.deepEqual(manifest.cases.map(item => item.id), ['D-named-introduce']);
    assert.equal(manifest.stoppedAfterTechnicalFailure, 'D-named-introduce');
    assert.equal(manifest.status, 'failed'); assert.equal(manifest.directoryStartup, undefined);
    assert.equal(manifest.executionScope.plannedBudget.maxArmWallMs, undefined);
    assert.ok(launches.every(row => row.caseId === 'D-named-introduce' && row.timeoutMs === 300000));
    assert.equal(prompts.length, fault === 'model-state' ? 0 : 1);
    assert.equal(costs[0].length, prompts.length, 'All original cost rows survive the stop');
    assert.deepEqual(manifest.notRunCases.map(item => [item.id, item.reason]), [
      ['C-introduce', 'not_selected_for_early_feedback'], ['D-natural-task', 'shared_technical_failure'], ['D-chat', 'shared_technical_failure'],
    ]);
    assert.equal(results[0].sharedTechnicalFailure, true);
    assert.equal(results[0].notRunTurns.length, fault === 'model-state' ? 2 : 1);
    assert.ok(results[0].notRunTurns.every(turn => turn.status === 'not_run' && turn.reason === 'shared_technical_failure'));
    if (fault === 'host') assert.equal(results[0].hostFinality.error.code, 'HOST_FINALITY_FAILED');
    if (fault.startsWith('model-')) assert.equal(results[0].modelContractFailure.code, fault === 'model-state' ? 'MODEL_STATE' : 'MODEL_ROUTE_EVIDENCE');
  });
});

test('ordinary daily D keeps independent intent failure distinct and runs later original cases', async () => {
  const config = { ...intentConfig(), modelContract: 'daily-route-v1', model: 'magpie/group/flash', thinkingLevel: 'high', rpcTimeoutMs: 300000 };
  await driveIntentStopping(config, 'intent', ({ manifest, results, prompts, exercises }) => {
    assert.deepEqual(manifest.cases.map(item => item.id), ['D-named-introduce', 'D-natural-task', 'D-chat']);
    assert.equal(prompts.length, 3); assert.equal(exercises.length, 1);
    assert.equal(manifest.stoppedAfterTechnicalFailure, undefined); assert.equal(manifest.status, 'failed');
    assert.equal(results[0].sharedTechnicalFailure, false);
    assert.deepEqual(results[0].notRunTurns.map(turn => [turn.intent, turn.reason]), [['reuse-introduction', 'failed_prerequisite']]);
    assert.deepEqual(manifest.notRunCases.map(item => item.id), ['C-introduce']);
  });
});

test('ordinary legacy D keeps its original continuation and ready D keeps its existing stop policy', async () => {
  await driveIntentStopping(intentConfig(), 'source', ({ manifest, prompts }) => {
    assert.equal(manifest.cases.length, 3); assert.equal(prompts.length, 3);
    assert.equal(manifest.stoppedAfterTechnicalFailure, undefined); assert.equal(manifest.notRunCases, undefined);
  });
  await driveIntentStopping(readyConfig(), 'source', ({ manifest, prompts }) => {
    assert.equal(manifest.cases.length, 1); assert.equal(prompts.length, 1);
    assert.equal(manifest.stoppedAfterTechnicalFailure, 'D-named-introduce');
    assert.equal(manifest.directoryStartup.maxArmWallMs, 1200000);
    assert.deepEqual(manifest.notRunCases.map(item => item.reason), ['not_selected_for_early_feedback', 'prior_technical_failure_or_arm_deadline', 'prior_technical_failure_or_arm_deadline']);
  });
});

const readyProviderInput = (mode, changedCard = {}) => {
  const encode = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const record = { id: 'target', ref: 'skill://target/SKILL.md', name: 'Target "quoted"', description: '\nDescription &quot; 中文\n' };
  const card = { ...record, path: 'sr:C' + 'A'.repeat(22), source: 'notion', ...changedCard };
  const inputSection = '<ntn-skills-view-catalog><available_skills><skill>'
    + ['name', 'description', 'source'].map(key => `<${key}>${encode(card[key])}</${key}>`).join('')
    + `<location>${encode(card.path)}</location></skill></available_skills></ntn-skills-view-catalog>`;
  const marker = '\nNotion cards are on demand; discover them with notion_list.';
  const outputSection = mode === 'full-cards' ? inputSection : inputSection.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, '') + marker;
  const input = { phase: 'discovery-input-catalog', sequence: 1, userTurn: 1, state: 'ready', systemPromptSha256: intentHash(inputSection),
    skills: [{ name: encode(record.name), path: 'sr:C' + 'A'.repeat(22), provenance: { source: 'verified-notion-metadata', loaded: false,
      ownerId: record.id, ref: record.ref, scope: 'scope' } }] };
  const proof = { phase: 'discovery-projection', sequence: 2, userTurn: 1, mode, stage: 'context_with_system', section: 'context-broker-notion-catalog',
    inputCatalogSequence: 1, inputSection, outputSection, inputSectionSha256: intentHash(inputSection), outputSectionSha256: intentHash(outputSection),
    inputSectionBytes: Buffer.byteLength(inputSection), outputSectionBytes: Buffer.byteLength(outputSection),
    inputMessagesSha256: intentHash('messages'), outputMessagesSha256: intentHash('messages'), preservedMessagesSha256: intentHash('preserved'),
    markerBytes: mode === 'full-cards' ? 0 : Buffer.byteLength(marker) };
  const actual = { phase: 'catalog', sequence: 3, stage: 'before_provider_request', userTurn: 1, providerPayloadSha256: 'actual-provider', state: 'ready',
    skills: mode === 'full-cards' ? structuredClone(input.skills) : [] };
  const provider = { phase: 'provider-request', sequence: 4, observedPayloadSha256: 'actual-provider', tools: ['read', 'notion_list', 'notion_use'], contents: [], payloadBytes: 500,
    discoveryProjection: { sequence: 2, mode, inputCatalogSequence: 1, outputSectionSha256: proof.outputSectionSha256,
      wireFragmentSha256: intentHash(outputSection.trim()), markerBytes: proof.markerBytes } };
  return { item: intentConfig().cases[3], oracle: { target: { scope: 'scope' } }, catalogRecords: [record], responses: [],
    discoveryExperiment: { version: 1, mode }, discoveryStartup: readyConfig().discoveryStartup,
    observation: [input, proof, actual, provider, { phase: 'provider-transport-start', sequence: 5, observedPayloadSha256: 'actual-provider', wireBodySha256: 'a'.repeat(64), wireBodyBytes: 500 },
      { phase: 'provider-transport-response', status: 200 }, { phase: 'assistant-final', success: true, text: 'Hello.' }] };
};

test('ready-directory first provider binds complete decoded metadata and distinguishes hidden cards', () => {
  for (const mode of ['full-cards', 'on-demand-cards']) {
    const value = readyProviderInput(mode);
    assert.equal(assertIntentTurn(value).status, 'passed');
    const verified = intentRunner.assertReadyDiscoveryProvider({ observation: value.observation, catalogRecords: value.catalogRecords,
      scope: 'scope', experiment: value.discoveryExperiment });
    assert.equal(verified.completeDescriptionBytes, Buffer.byteLength(value.catalogRecords[0].description));
    assert.match(verified.visibility, mode === 'full-cards' ? /actual provider system/ : /before the public on-demand projection/);
    assert.equal(value.observation[2].skills.length, mode === 'full-cards' ? 1 : 0, 'Hidden cards must not be called outer provider-visible');
    for (const changed of [{ name: 'other' }, { description: 'Description &quot; 中文' },
      { description: '\nDescription " 中文\n' }, { path: 'skill://other/SKILL.md' }, { source: 'foreign' }])
      assert.throws(() => assertIntentTurn(readyProviderInput(mode, changed)));
    for (const mutate of [
      item => { item.observation[2].stage = 'context_with_system'; },
      item => { item.observation[2].providerPayloadSha256 = 'another-provider'; },
      item => { item.observation[0].skills[0].provenance.ref = 'skill://another/SKILL.md'; },
      item => { item.observation.splice(3, 0, structuredClone(item.observation[2])); },
    ]) { const wrong = structuredClone(value); mutate(wrong); assert.throws(() => assertIntentTurn(wrong)); }
  }
});

test('chat keeps completed ordinary 298 metadata separate from a shutdown-cancelled Default View', () => {
  const value = pendingChatSource(), actual = assertIntentSource(value);
  assert.equal(actual.default_catalog, 'not_observed_before_shutdown');
  assert.equal(actual.sdk_calls.list, 2); assert.equal(actual.actual_http_attempts, 2);
  assert.equal(actual.request_bytes, 237); assert.equal(actual.response_bytes, null);
  assert.equal(actual.cancelled_catalogs[0].countedAsReady, false);
  assert.ok(actual.httpAttempts.every(attempt => attempt.kind === 'metadata'));
  assert.equal(actual.unselected_body_reads, 0); assert.deepEqual(actual.source_writes, []);
  // Identical ordinary members are still not a completed View observation.
  value.responses[0].value.records = structuredClone(value.catalogRecords); value.responses[0].value.count = 74;
  assert.equal(assertIntentSource(value).default_catalog, 'not_observed_before_shutdown');
});

test('chat cancellation cannot excuse partial, foreign or View-marked ordinary metadata', () => {
  for (const mutate of [
    value => { value.responses[0].value.scope = 'foreign'; },
    value => { value.responses[0].value.coverage.exhaustive = false; },
    value => { value.responses[0].value.coverage.failed_sources = [{ id: 'source', code: 'AUTH_REQUIRED' }]; },
    value => { value.responses[0].value.coverage.search_index_limited = true; },
    value => { value.responses[0].value.count = 297; },
    value => { value.responses[0].value.records[1] = value.responses[0].value.records[0]; },
    value => { value.responses[0].value.view = null; },
    value => { value.responses[0].value.profile = { profile_id: 'profile' }; },
    value => { value.responses[0].value.capability_directory = true; },
    value => { value.responses[0].value.coverage.method = 'search_and_registered'; },
  ]) { const value = pendingChatSource(); mutate(value); assert.throws(() => assertIntentSource(value)); }
});

test('completed Default Views must each match the frozen complete same-scope directory', () => {
  const value = completeDefaultSource();
  assert.equal(assertIntentSource(value).default_catalog, 'observed_complete_production_default');
  for (const mutate of [
    result => { result.scope = 'foreign'; },
    result => { result.records[0].name = 'changed'; },
    result => { result.records[0].description = 'changed'; },
    result => { result.records[0].ref = 'skill://wrong/SKILL.md'; },
    result => { result.records.pop(); result.count--; },
    result => { result.coverage.exhaustive = false; },
    result => { result.coverage.failed_sources = [{ id: 'source', code: 'NOT_FOUND' }]; },
    result => { result.capability_directory = false; },
    result => { delete result.view; },
  ]) {
    const candidate = completeDefaultSource(), extra = structuredClone(candidate.responses[1]);
    extra.requestId = 'three'; mutate(extra.value); candidate.responses.push(extra);
    candidate.sourceLedger.splice(-1, 0, { phase: 'sdk-start', requestId: 'three', operation: 'list', pid: 42, monotonic_ns: '70' },
      { phase: 'sdk-end', requestId: 'three', operation: 'list', pid: 42, monotonic_ns: '80' });
    assert.throws(() => assertIntentSource(candidate), 'One matching View must not hide another completed invalid View');
  }
});

test('missing Default completion is only allowed for pending chat with actual shutdown, EOF and metadata-only source work', () => {
  for (const mutate of [
    value => { value.metadataOnly = false; },
    value => { value.observation = []; },
    value => { value.observation[0].stage = 'before_agent_start'; },
    value => { value.observation[0].state = 'ready'; },
    value => { value.sourceLedger = value.sourceLedger.filter(row => row.phase !== 'native-session-shutdown'); },
    value => { value.sourceLedger.find(row => row.phase === 'native-session-shutdown').pid = 99; },
    value => { value.sourceLedger.find(row => row.phase === 'native-session-shutdown').monotonic_ns = '61'; },
    value => { value.sourceLedger.pop(); },
    value => { value.sourceLedger.at(-1).pending = 1; },
    value => { value.hostLedger.pop(); },
    value => { value.responses[1].value = { records: [] }; },
    value => { value.responses[1].resultObserved = true; },
    value => { value.responses[1].status = 'failed'; },
    value => { value.responses[0].metrics.trace[0].request_kind = 'notion_body'; },
    value => { value.responses[0].metrics.trace[0].request_kind = 'notion_write'; },
    value => { value.responses[0].metrics.trace[0].request_kind = 'unknown'; },
    value => { value.responses[0].operation = value.sourceLedger[1].operation = value.sourceLedger[2].operation = 'consume'; },
  ]) { const value = pendingChatSource(); mutate(value); assert.throws(() => assertIntentSource(value)); }
  const noCancellation = pendingChatSource(); noCancellation.responses.pop();
  noCancellation.sourceLedger = noCancellation.sourceLedger.filter(row => row.requestId !== 'two' && row.phase !== 'native-session-shutdown');
  assert.throws(() => assertIntentSource(noCancellation));
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

test('current metadata accepts one independently witnessed provider projection without claiming an exact tool copy', () => {
  const events = good();
  for (const event of events.filter(row => row.phase === 'request')) event.tools = ['read', 'notion_list', 'notion_use'];
  const card = { ref: 'sr:C' + 'A'.repeat(22), name: 'owned', description: 'Complete source description', source: 'notion', kind: 'skill', availability: 'available' };
  const { description, ...thinCard } = card;
  const full = JSON.stringify({ records: [card] }), projected = JSON.stringify({ records: [thinCard] });
  const metadata = { phase: 'metadata-result', tool: 'notion_list', toolCallId: 'metadata', sha256: intentHash(full), bytes: Buffer.byteLength(full), complete: true };
  const delivery = { tool: 'notion_list', toolCallId: metadata.toolCallId, sha256: metadata.sha256, bytes: metadata.bytes, exactToolOutputCopies: 0,
    metadataProjections: [{ sha256: intentHash(projected), bytes: Buffer.byteLength(projected), sourceSha256: metadata.sha256, sourceBytes: metadata.bytes,
      descriptionReuse: [{ origin: 'actual-default-card', ref: card.ref, description, system_sha256: intentHash('complete default card') }] }] };
  const evidence = value => [...[0, 1].map(index => ({ phase: 'provider-request', tools: ['read', 'notion_list', 'notion_use'], toolResults: index ? [value] : [] })), metadata];
  assert.equal(assertModelCase(events, expected, { graphEvents: evidence(delivery) }).providerRequests, 2);
  assert.equal(delivery.exactToolOutputCopies, 0, 'Projected metadata never masquerades as the full native output');
  for (const mutate of [
    value => { value.metadataProjections[0].sourceSha256 = intentHash('other result'); },
    value => { value.metadataProjections[0].sourceBytes++; },
    value => { value.metadataProjections[0].descriptionReuse = []; },
    value => { value.metadataProjections[0].descriptionReuse[0].origin = 'loaded-label'; },
    value => { value.metadataProjections[0].descriptionReuse[0].ref = 'sr:S' + 'A'.repeat(22); },
    value => { value.metadataProjections.push(structuredClone(value.metadataProjections[0])); },
    value => { value.exactToolOutputCopies = 1; },
    value => { value.exactToolOutputCopies = 2; },
    value => { value.tool = 'skill_search'; },
    value => { value.metadataProjections[0].sha256 = metadata.sha256; },
    value => { value.metadataProjections[0].sha256 = 'unverified'; },
    value => { value.metadataProjections[0].bytes = 0; },
  ]) {
    const invalid = structuredClone(delivery); mutate(invalid);
    assert.throws(() => assertModelCase(events, expected, { graphEvents: evidence(invalid) }), /Metadata must reach the provider/);
  }
  const historical = evidence(delivery);
  for (const row of historical.filter(row => row.phase === 'provider-request')) row.tools = ['read', 'skill_search', 'skill_prepare'];
  for (const row of events.filter(row => row.phase === 'request')) row.tools = ['read', 'skill_search', 'skill_prepare'];
  assert.throws(() => assertModelCase(events, expected, { graphEvents: historical, toolContract: 'legacy-pi-tools' }), /Metadata must reach the provider/);
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
