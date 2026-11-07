#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, appendFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost, runCommand, assertSupportedPiVersion } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { createRequestLedger } from './notion-default-context.mjs';
import { decodeCatalogText } from './notion-integration-hosts.mjs';
import { observe } from './notion-integration-model.mjs';
import { graphObserverModule, sourceObserver, graphSourceAttribution, collectSupplementaryRetainedProof, createGraphFallbackTraps } from './notion-skill-graph-model.mjs';
import { catalogFacets, graphSourceViews, graphSourceAccounting } from './notion-skill-graph-model-evidence.mjs';
import { createOwnedGraphProject, inspectOwnedGraphProject, retainGeneratedPlan, verifyGeneratedExerciseAcceptance } from './notion-skill-graph-project.mjs';
import { createPiHelpBoundary } from './notion-pi-help.mjs';
import { installedBrokerIdentity } from './notion-skill-graph-session.mjs';
import { verificationCliEnvironment, systemTempRoot } from './verification-paths.mjs';
import { assertCatalogCancellationBoundary } from './notion-sdk-pi.mjs';
import { consumptionCostExtensionSource, readConsumptionCostEvents } from './skill-consumption-cost.mjs';
import { dailyRouteContract, verifyDailyRouteState, verifyDailyRouteEvidence } from './verify-skill-graph-contract.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const rows = async path => { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const hash = value => createHash('sha256').update(value).digest('hex');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function discoveryExperimentIdentity(config) {
  if (config.discoveryExperiment === undefined) return undefined;
  const { evidenceRoot: _evidence, discoveryExperiment, ...sameInputs } = config;
  const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return { ...discoveryExperiment, comparisonSha256: hash(canonical({ ...sameInputs, discoveryExperiment: { version: discoveryExperiment.version } })),
    changedInput: 'Broker-owned default card presentation and its target-free on-demand notice only',
    notClaimed: ['Production adoption', 'Formal SC21 acceptance', 'SC20 native Skill equivalence'] };
}

export function validateIntentConfiguration(config) {
  const modelProfile = dailyRouteContract(config);
  assert.equal(config.version, 1); assert.equal(config.contract, 'agent-cli-ref-20261105');
  if (config.discoveryExperiment === undefined) assert.equal(config.phase, 'early-feedback-not-formal-SC21');
  else {
    assert.equal(config.phase, 'SC06-discovery-prototype');
    assert.deepEqual(Object.keys(config.discoveryExperiment).sort(), ['mode', 'version']);
    assert.equal(config.discoveryExperiment.version, 1);
    assert.ok(['full-cards', 'on-demand-cards'].includes(config.discoveryExperiment.mode));
  }
  if (config.discoveryStartup !== undefined) {
    assert.ok(config.discoveryExperiment, 'Ready-directory startup is an explicit D discovery experiment');
    assert.deepEqual(config.discoveryStartup, { mode: 'ready-directory', timeoutMs: 60000 });
  }
  assert.equal(config.model, modelProfile?.model ?? 'magpie/group/flash-free'); assert.equal(config.fallback, 'forbidden');
  assert.equal(config.sampling.codeMode, false);
  assert.deepEqual(config.sampling.tools, ['read', 'notion_list', 'notion_use']);
  assert.deepEqual(config.budget, { primarySamplesPerCase: 1, primaryCases: 4, maxFollowupSubmissions: 3,
    maxSubmissions: 7, timeoutMsPerSubmission: 300000, maxScheduledPromptMs: 2100000,
    automaticRetries: 0, continueAfterFailedPrerequisite: false });
  assert.equal(config.source.sourceMode, 'sdk'); assert.equal(config.source.prefetch, false);
  for (const key of ['command', 'default_view_id', 'profile_id', 'viewId', 'profileId'])
    assert.equal(config.source[key], undefined, 'The ordinary production default cannot be narrowed for D');
  assert.equal(config.source.catalogEvidence.count, 74);
  assert.equal(config.privateOracle.consumerVisible, false); assert.equal(config.privateOracle.noPrivateTargetSeedForD, true);
  assert.deepEqual(config.cases.map(item => item.id), ['C-introduce', 'D-named-introduce', 'D-natural-task', 'D-chat']);
  assert.deepEqual(config.cases.map(item => item.entryMode), ['explicit-root', 'discovery-only', 'discovery-only', 'discovery-only']);
  assert.deepEqual(config.cases.map(item => item.intent), ['introduce', 'introduce', 'produce-and-exercise-artifact', 'chat']);
  assert.deepEqual(config.cases.map(item => item.followups.length), [2, 1, 0, 0]);
  for (const item of config.cases) {
    assert.equal(item.rootRef, undefined, 'Per-case private targets cannot seed discovery');
    for (const prompt of [item.initial, ...item.followups.map(turn => turn.prompt)]) {
      assert.equal(typeof prompt.text, 'string'); assert.equal(hash(prompt.text), prompt.sha256);
      if (item.entryMode === 'discovery-only') assert.ok(!prompt.text.includes('$') && !prompt.text.includes('skill://') && !prompt.text.includes('sr:'), 'D uses its frozen ordinary prompt without reference seeds');
    }
  }
  assert.deepEqual(config.cases[0].followups.map(item => item.intent), ['reuse-introduction', 'explicit-reread']);
  assert.equal(config.cases[1].followups[0].mode, 'restart-and-resume-same-session');
  return config;
}

export function selectIntentCases(config, selectedCase) {
  validateIntentConfiguration(config);
  if (config.discoveryExperiment !== undefined) assert.equal(selectedCase, 'D-early', 'SC06 discovery experiments require the original D-early selection');
  if (selectedCase !== undefined) assert.ok(['C-introduce', 'D-early'].includes(selectedCase), 'Only the explicitly authorized C-introduce or D-early selection is supported');
  const selected = config.cases.filter(item => selectedCase === undefined || (selectedCase === 'D-early' ? item.id !== 'C-introduce' : item.id === selectedCase));
  const followups = selected.reduce((count, item) => count + item.followups.length, 0), submissions = selected.length + followups;
  return { mode: selectedCase === undefined ? 'all' : 'targeted', selectedCaseIds: selected.map(item => item.id),
    notRunCases: config.cases.filter(item => !selected.includes(item)).map(item => ({ id: item.id, status: 'not_run', reason: 'not_selected_for_early_feedback' })),
    plannedBudget: { ...config.budget, primaryCases: selected.length, maxFollowupSubmissions: followups,
      maxSubmissions: submissions, maxScheduledPromptMs: submissions * config.budget.timeoutMsPerSubmission,
      ...(config.discoveryStartup ? { maxArmWallMs: 1200000, directorySetup: { perCaseMs: 60000,
        maxCases: selected.length, maxSetupMs: selected.length * 60000, includedInArmWall: true } } : {}) } };
}

const catalogShape = records => records.map(record => [record.id, record.name, record.description, record.ref]).sort((a, b) => a[0].localeCompare(b[0]));
const discoveryTimeout = (code, message) => Object.assign(new Error(message), { code });

/** An opt-in arm has one wall budget, including all startup work. A local stage
 * can spend only the smaller of its own allowance and the remaining arm time. */
export function discoveryAllowance({ armStartedMs, stageStartedMs, stageLimitMs, nowMs }) {
  const arm = 1200000 - (nowMs - armStartedMs), stage = stageLimitMs - (nowMs - stageStartedMs);
  if (arm <= 0) throw discoveryTimeout('DISCOVERY_ARM_TIMEOUT', 'The 1200-second arm wall budget includes directory setup');
  if (stage <= 0) throw discoveryTimeout('DISCOVERY_STAGE_TIMEOUT', 'The original discovery stage deadline elapsed');
  return Math.min(arm, stage);
}

async function withinDiscoveryBudget(operation, { armStartedMs, stageStartedMs, stageLimitMs, stop, now = () => performance.now() }) {
  const remaining = () => discoveryAllowance({ armStartedMs, stageStartedMs, stageLimitMs, nowMs: now() });
  const allowance = remaining(); let timer, timedOut = false;
  try {
    const value = await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(discoveryTimeout(
        now() - armStartedMs >= 1200000 ? 'DISCOVERY_ARM_TIMEOUT' : 'DISCOVERY_STAGE_TIMEOUT',
        'Discovery work exceeded its remaining wall budget')); }, allowance);
    })]);
    remaining(); return value;
  } catch (error) {
    if (timedOut || error.code?.startsWith('DISCOVERY_')) await stop().catch(failure => { error.message += '; shutdown: ' + failure.message; });
    throw error;
  } finally { clearTimeout(timer); }
}

/** Completed source facts and the native local status must agree. This does
 * not establish model visibility; the first actual provider is checked later. */
export function inspectDiscoveryStartup({ observation, sourceLedger, responses, statusFrame, handled, catalog, sourceId = 'notion', pid }) {
  assert.equal(handled?.agentInvoked, false, 'The bare View command must be handled without invoking an agent');
  assert.equal(statusFrame?.type, 'extension_ui_request'); assert.equal(statusFrame.method, 'notify');
  assert.equal(statusFrame.notifyType, 'info', 'A failed View status cannot open a task');
  assert.ok(!observation.some(event => ['native-input', 'catalog-before-agent-start', 'provider-request', 'provider-transport-start',
    'assistant-final', 'authored-tool-call', 'tool-call', 'tool-result', 'metadata-result', 'project-read-result', 'observer-error'].includes(event.phase)),
  'Directory setup cannot submit a greeting, invoke a model, or read project/Skill bodies');
  assert.ok(sourceLedger.some(event => event.phase === 'sdk-observer-start' && event.pid === pid), 'Observe the actual initial Pi source process');
  assert.ok(!sourceLedger.some(event => ['sdk-observer-error', 'sdk-observer-end', 'native-session-shutdown'].includes(event.phase)), 'Setup requires a live, intact source observer');
  assert.ok(!sourceLedger.some(event => ['child-spawn', 'alternate-child-api'].includes(event.phase) && event.source), 'Setup cannot invoke a source CLI');
  const starts = sourceLedger.filter(event => event.phase === 'sdk-start'), ends = sourceLedger.filter(event => event.phase === 'sdk-end');
  assert.equal(new Set(starts.map(event => event.requestId)).size, starts.length);
  assert.equal(ends.length, responses.length); assert.equal(new Set(ends.map(event => event.requestId)).size, ends.length);
  assert.ok(starts.every(event => event.pid === pid && event.operation === 'list'), 'Only native startup metadata is permitted');
  const defaults = [], attempts = [];
  for (const end of ends) {
    const start = starts.find(event => event.requestId === end.requestId), matches = responses.filter(receipt => receipt.requestId === end.requestId);
    assert.ok(start); assert.equal(end.pid, pid); assert.equal(end.operation, start.operation);
    assert.equal(end.status, 'completed', 'Cancelled or failed setup cannot become ready');
    assert.equal(end.metricsComplete, true); assert.equal(end.resultObserved, true); assert.equal(matches.length, 1);
    const receipt = matches[0];
    assert.equal(receipt.transport, 'sdk'); assert.equal(receipt.operation, 'list'); assert.equal(receipt.status, 'completed');
    assert.equal(receipt.resultObserved, true); assert.equal(receipt.sdk_started, true); assert.equal(receipt.metrics_observed, true);
    assert.equal(receipt.metrics?.complete, true);
    const measured = receipt.metrics.trace.filter(event => event.event === 'attempt');
    assert.equal(measured.length, receipt.metrics.total_requests); assert.equal(new Set(measured.map(event => event.attempt)).size, measured.length);
    assert.ok(measured.every(event => event.request_kind === 'notion_metadata'), 'Setup body/write/unknown attempts are forbidden');
    attempts.push(...measured);
    for (const outcome of catalogFacets(receipt.value)) {
      assert.equal(outcome.ok, true, 'Failed catalog projections cannot open the task');
      const value = outcome.value;
      assert.equal(value?.scope, catalog.scope); assert.equal(value.count, value.records.length);
      assert.equal(new Set(value.records.map(record => record.id)).size, value.count);
      assert.ok(value.records.every(record => ['id', 'name', 'description', 'ref'].every(key => typeof record[key] === 'string')));
      assert.equal(value.coverage?.exhaustive, true); assert.deepEqual(value.coverage?.failed_sources, []);
      assert.equal(value.coverage?.search_index_limited, false);
      const ordinary = value.coverage.method === 'explicit_database'
        && ['view', 'view_selection', 'view_query', 'profile', 'capability_directory'].every(key => !Object.hasOwn(value, key));
      if (ordinary) { assert.notEqual(outcome.facet, 'directory', 'A full inventory is not a Default View'); continue; }
      assert.equal(value.coverage.method, 'explicit_view'); assert.equal(value.capability_directory, true);
      assert.equal(value.view_selection, 'first'); assert.equal(value.profile, undefined);
      assert.equal(value.view?.id, catalog.view.id); assert.equal(value.view.name, catalog.view.name);
      assert.deepEqual(catalogShape(value.records), catalogShape(catalog.records), 'Setup must observe the complete frozen Default View');
      defaults.push(receipt.requestId);
    }
  }
  const expectedStatus = `${sourceId}: ${catalog.view.name} (${catalog.view.id}) · ${catalog.records.filter(record => record.kind !== 'prompt').length} Skill/Router · first`;
  const statusReady = statusFrame.message === expectedStatus;
  assert.ok(statusReady || statusFrame.message === 'Notion Views: no enabled Notion sources', 'Partial, empty, failed or unexpected View state cannot open the task');
  const sum = key => attempts.every(event => Number.isSafeInteger(event[key]) && event[key] >= 0)
    ? attempts.reduce((total, event) => total + event[key], 0) : null;
  return { state: statusReady && defaults.length > 0 && ends.length === starts.length ? 'ready' : 'pending',
    defaultRequestIds: defaults, startedSdkIds: starts.map(event => event.requestId), completedSdkIds: ends.map(event => event.requestId),
    httpAttempts: attempts.length, requestBytes: sum('request_bytes'), responseBytes: sum('response_bytes'),
    accounting: 'Startup prefix of the original whole-case source ledger, not an additional cost total', modelVisibility: 'not_yet_observed' };
}

export async function waitForDiscoveryReady({ rpc, snapshot, catalog, armStartedMs, setupStartedMs, stop, savePoll,
  now = () => performance.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const bounded = operation => withinDiscoveryBudget(operation, { armStartedMs, stageStartedMs: setupStartedMs, stageLimitMs: 60000, stop, now });
  const commands = await bounded(() => rpc.command('get_commands'));
  assert.equal(commands.commands?.filter(command => command.name === 'context-broker' && command.source === 'extension').length, 1,
    'The native command must be registered before sending local status input');
  const initialMessages = await bounded(() => rpc.command('get_messages')), polls = [];
  assert.equal(initialMessages.messages?.length, 0, 'Ready discovery starts in the original empty session');
  while (true) {
    discoveryAllowance({ armStartedMs, stageStartedMs: setupStartedMs, stageLimitMs: 60000, nowMs: now() });
    const frameStart = rpc.frames.length, startedAt = new Date().toISOString();
    const handled = await bounded(() => rpc.prompt('/context-broker view'));
    const frames = rpc.frames.slice(frameStart), notifications = frames.filter(frame => frame.type === 'extension_ui_request' && frame.method === 'notify');
    assert.equal(notifications.length, 1, 'Keep the actual bare View notification, not an invented ready flag');
    const captured = await snapshot(), status = inspectDiscoveryStartup({ ...captured, statusFrame: notifications[0], handled, catalog,
      pid: rpc.lifecycle.find(event => event.event === 'spawn')?.pid });
    const poll = { index: polls.length, startedAt, finishedAt: new Date().toISOString(), frameStart, frameEnd: rpc.frames.length,
      command: '/context-broker view', handled, frames, status, sourcePrefix: { rows: captured.sourceLedger.length,
        sha256: hash(JSON.stringify(captured.sourceLedger)), receipts: captured.responses.map(receipt => ({ requestId: receipt.requestId, sha256: hash(JSON.stringify(receipt)) })) } };
    polls.push(poll); await savePoll(poll);
    if (status.state === 'ready') {
      assert.deepEqual(await bounded(() => rpc.command('get_messages')), initialMessages, 'Local status commands cannot add a model-visible message');
      return { status: 'ready', elapsedMs: now() - setupStartedMs, polls, ...status,
        sessionMessagesSha256: hash(JSON.stringify(initialMessages)), setupProviderRequests: 0, setupBodyRequests: 0,
        setupSourceCosts: 'Included once in sourceAccounting for the entire case; these prefix values are non-additive' };
    }
    await pause(Math.min(250, discoveryAllowance({ armStartedMs, stageStartedMs: setupStartedMs, stageLimitMs: 60000, nowMs: now() })));
  }
}

export function intentRunStatus(scope, cases, semanticStatus) {
  if (semanticStatus !== undefined) assert.ok(['passed', 'failed'].includes(semanticStatus));
  const ids = cases.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'A case cannot be counted twice');
  assert.deepEqual(ids, scope.selectedCaseIds.slice(0, ids.length), 'Only the explicitly selected cases can contribute to this run');
  if (cases.length !== scope.selectedCaseIds.length || cases.some(item => item.status !== 'passed') || semanticStatus === 'failed') return 'failed';
  if (semanticStatus === undefined) return 'review_required';
  return scope.mode === 'all' ? 'passed' : 'partial';
}

export function intentTechnicalFailure({ result, sourceComplete, observation }) {
  return result.hostFinality?.status === 'failed' || !sourceComplete
    || ['MODEL_STATE', 'MODEL_ROUTE_EVIDENCE'].includes(result.modelContractFailure?.code)
    || observation.some(event => ['observer-error', 'provider-transport-blocked'].includes(event.phase));
}

export function discoveryTechnicalFailure(input) {
  const { result } = input;
  return intentTechnicalFailure(input) || result.directorySetup.status !== 'ready'
    || result.directorySetup.firstProvider?.status !== 'verified' || result.discoveryExperiment.costStatus !== 'complete';
}

const exactFile = (file, expected) => file.ownerId === expected.logicalId && file.scope === expected.scope
  && file.snapshot === expected.snapshot && file.sha256 === expected.sha256 && file.bytes === expected.bytes
  && (expected.ref === undefined || file.ref === expected.ref);

export function assertReadyDiscoveryProvider({ observation, catalogRecords, scope, experiment }) {
  const first = observation.find(event => event.phase === 'provider-request');
  const actual = observation.filter(event => event.phase === 'catalog' && event.stage === 'before_provider_request'
    && first && event.providerPayloadSha256 === first.observedPayloadSha256 && event.sequence < first.sequence);
  assert.ok(experiment, 'The ready first provider needs the explicitly frozen discovery projection');
  const input = assertDiscoveryProjection({ observation, experiment });
  assert.ok(first && actual.length === 1 && actual[0].state === 'ready' && input[0]?.state === 'ready', 'The ready stratum requires the first provider to observe ready metadata');
  assert.deepEqual(input[0].skills.map(skill => [skill.provenance?.ownerId, skill.provenance?.ref]).sort(),
    catalogRecords.map(record => [record.id, record.ref]).sort(), 'The ready first provider must match every frozen Default owner/ref');
  assert.ok(input[0].skills.every(skill => skill.provenance?.source === 'verified-notion-metadata'
    && skill.provenance.scope === scope && skill.provenance.loaded === false));
  const proof = observation.find(event => event.phase === 'discovery-projection' && event.sequence === first.discoveryProjection.sequence);
  // The original graph observer verifies metadata against SDK returns. Bind the
  // complete first section to the separately frozen directory as well, without
  // confusing an on-demand input section with cards sent to the provider.
  const cards = [...proof.inputSection.matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map(match => {
    const field = name => {
      const values = [...match[1].matchAll(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'g'))];
      assert.equal(values.length, 1, 'The ready first provider needs each complete metadata field exactly once');
      return decodeCatalogText(values[0][1]);
    };
    return { name: field('name'), description: field('description'), path: field('location'), source: field('source') };
  });
  assert.equal(cards.length, input[0].skills.length); assert.equal(new Set(cards.map(card => card.path)).size, cards.length);
  for (const card of cards) {
    const declared = input[0].skills.find(skill => skill.path === card.path);
    const record = catalogRecords.find(record => record.id === declared?.provenance?.ownerId);
    assert.ok(record); assert.equal(card.source, 'notion');
    assert.equal(card.name, record.name, 'First provider name must match the frozen source exactly');
    assert.equal(card.description, record.description, 'First provider complete description must match the frozen source exactly');
    assert.equal(declared.provenance.ref, record.ref);
  }
  return { status: 'verified', sequence: first.sequence, observedPayloadSha256: first.observedPayloadSha256,
    catalogSequence: actual[0].sequence, inputCatalogSequence: input[0].sequence, count: input[0].skills.length,
    completeDescriptionBytes: cards.reduce((sum, card) => sum + Buffer.byteLength(card.description), 0),
    inputSectionSha256: proof.inputSectionSha256, outputSectionSha256: proof.outputSectionSha256,
    visibility: experiment?.mode === 'on-demand-cards' ? 'ready source directory verified before the public on-demand projection' : 'ready cards in actual provider system' };
}

export function assertIntentTurn({ observation, turnObservation = observation, responses, newResponses = responses,
  item, intent = item.intent, oracle, catalogRecords, followup = false, discoveryExperiment, discoveryStartup, modelProfile }) {
  const providers = turnObservation.filter(event => event.phase === 'provider-request');
  const modelEvidence = modelProfile && verifyDailyRouteEvidence(modelProfile, {
    states: observation.filter(event => event.phase === 'model-state').map(event => event.state), requests: providers,
    transports: turnObservation.filter(event => event.phase === 'provider-transport-start'),
    responses: turnObservation.filter(event => event.phase === 'model-response') });
  assert.ok(providers.length, 'Actual verified provider input is required');
  assert.ok(turnObservation.some(event => event.phase === 'provider-transport-response' && event.status >= 200 && event.status < 300), 'Actual provider HTTP success is required');
  assert.ok(!turnObservation.some(event => ['observer-error', 'provider-transport-blocked'].includes(event.phase)), 'A failed observer cannot establish delivery');
  assert.ok(providers.every(event => JSON.stringify([...event.tools].sort()) === JSON.stringify(['notion_list', 'notion_use', 'read'])));
  assert.ok(!turnObservation.some(event => event.phase === 'tool-call' && event.allowed !== true), 'A blocked or unauthored model call remains a failure');
  const outputs = turnObservation.filter(event => ['tool-result', 'metadata-result', 'preparation-result', 'project-read-result'].includes(event.phase));
  assert.ok(outputs.every(event => event.complete === true), 'Every actual selected output must be complete');
  for (const request of providers) {
    const keys = request.contents.map(file => JSON.stringify([file.scope, file.ownerId, file.snapshot, file.ref]));
    assert.equal(new Set(keys).size, keys.length, 'Provider must not receive duplicate complete bodies');
  }
  const final = turnObservation.filter(event => event.phase === 'assistant-final').at(-1);
  assert.ok(final?.success && final.text?.trim(), 'A successful nonempty final is required');
  if (item.entryMode === 'discovery-only' && !followup) assert.equal(providers[0].contents.length, 0, 'D starts from metadata without preloaded Skill bodies');
  const views = graphSourceViews(responses);
  const catalog = turnObservation.filter(event => event.phase === 'catalog');
  const inputCatalog = discoveryExperiment === undefined ? catalog
    : assertDiscoveryProjection({ observation: turnObservation, experiment: discoveryExperiment });
  if (discoveryStartup && !followup) assertReadyDiscoveryProvider({ observation: turnObservation,
    catalogRecords, scope: oracle.target.scope, experiment: discoveryExperiment });
  for (const current of inputCatalog) {
    if (current.state === 'pending') continue;
    assert.equal(current.state, 'ready');
    assert.deepEqual(current.skills.map(skill => skill.provenance?.ownerId).sort(), catalogRecords.map(record => record.id).sort(), 'Ready default directory must contain the actual production 74');
    for (const skill of current.skills) {
      const record = catalogRecords.find(record => record.id === skill.provenance?.ownerId);
      assert.equal(skill.provenance.source, 'verified-notion-metadata'); assert.equal(skill.provenance.loaded, false);
      assert.equal(skill.provenance.scope, oracle.target.scope);
      const name = skill.name.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
      assert.equal(name, record.name, 'Display the actual record name, not a command alias');
    }
  }
  const target = { ...oracle.target, sha256: oracle.target.bodySha256, bytes: oracle.target.bodyBytes };
  const targetReads = observation.filter(event => event.phase === 'tool-result' && event.complete && event.tool === 'read' && exactFile(event, target));
  // Use graphs also advertise known Members; only prepared nodes carry the use closure.
  const targetUses = views.preparations.filter(row => row.value.purpose === 'use'
    && row.value.nodes.some(node => node.id === oracle.target.logicalId && node.state === 'prepared'));
  if (item.intent === 'chat') {
    assert.ok(providers.every(request => request.contents.length === 0), 'Chat cannot load Skill or resource bodies');
    assert.equal(views.entries.length, 0); assert.equal(views.resources.length, 0); assert.equal(views.preparations.length, 0);
  } else if (item.intent === 'introduce') {
    assert.ok(targetReads.length, 'Introduction requires an actual native inspect/read of the selected target');
    assert.ok(providers.some(request => request.contents.some(file => exactFile(file, target))), 'The complete target body must reach the real provider');
    assert.equal(targetUses.length, 0, 'Introduction must not activate the target workflow');
    const uses = views.preparations.filter(row => row.value.purpose === 'use');
    if (item.entryMode === 'discovery-only') assert.equal(uses.length, 0, 'Ordinary introduction inspects rather than activates a workflow');
    else assert.ok(uses.every(row => row.value.roots.length === 1 && row.value.roots[0].id === oracle.preparations.B.find(body => body.role === 'root').logicalId),
      'C may activate only its explicitly selected root');
    if (item.entryMode === 'explicit-root' && !followup) {
      const expected = oracle.preparations.B;
      for (const body of expected) assert.equal(providers[0].contents.filter(file => exactFile(file, body)).length, 1, 'C must deliver its root and full Requires before the first provider');
      assert.ok(views.preparations.some(row => row.value.purpose === 'use' && row.value.roots.some(root => root.id === expected.find(body => body.role === 'root').logicalId)));
    }
    if (intent === 'reuse-introduction') {
      assert.equal(newResponses.filter(row => row.operation !== 'list').length, 0, 'Ordinary reuse cannot silently read or prepare bodies again');
      assert.equal(providers[0].contents.filter(file => exactFile(file, target)).length, 1,
        'Ordinary reuse must restore the complete selected body before the first provider');
    }
    if (intent === 'explicit-reread') {
      assert.ok(turnObservation.some(event => event.phase === 'tool-result' && event.tool === 'read' && event.complete && exactFile(event, target)), 'Explicit reread needs its own actual read result');
    }
  } else {
    assert.ok(turnObservation.some(event => event.phase === 'project-read-result' && event.complete && event.path.startsWith('src/')), 'A generated procedure must be grounded in the actual owned project');
    const uses = views.preparations.filter(row => row.value.purpose === 'use');
    assert.ok(uses.length, 'The natural task must actually use its chosen Skill');
    for (const row of uses) for (const node of row.value.nodes.filter(node => node.state === 'prepared')) {
      const expected = { logicalId: node.id, scope: row.value.scope, snapshot: node.binding.snapshot_id, sha256: node.body_sha256, bytes: node.bytes };
      assert.ok(providers.some(request => request.contents.some(file => exactFile(file, expected))), 'Every chosen root and Required body must reach an actual provider');
    }
  }
  return { status: 'passed', acceptance: 'technical_only', final: { ...final, sha256: hash(final.text), bytes: Buffer.byteLength(final.text) },
    ...(modelEvidence ? { modelProfile, modelEvidence } : {}),
    provider_requests: providers.length, provider_input_bytes: providers.reduce((sum, item) => sum + item.payloadBytes, 0),
    tool_calls: turnObservation.filter(event => event.phase === 'tool-call').length,
    catalog_states: catalog.map(event => event.state), semantic_review: 'required',
    ...(discoveryExperiment ? { discoveryExperiment, input_catalog_states: inputCatalog.map(event => event.state) } : {}) };
}

export function assertDiscoveryProjection({ observation, experiment }) {
  assert.equal(experiment.version, 1); assert.ok(['full-cards', 'on-demand-cards'].includes(experiment.mode));
  const providers = observation.filter(event => event.phase === 'provider-request');
  const projections = observation.filter(event => event.phase === 'discovery-projection');
  assert.ok(providers.length); assert.equal(projections.length, providers.length, 'Every experimental provider needs its own public projection');
  const consumed = new Set(), inputs = [];
  for (const provider of providers) {
    const binding = provider.discoveryProjection, proof = projections.find(event => event.sequence === binding?.sequence);
    assert.ok(proof && !consumed.has(proof.sequence), 'A public projection cannot be skipped or reused across providers');
    consumed.add(proof.sequence);
    assert.equal(proof.mode, experiment.mode); assert.equal(binding.mode, experiment.mode);
    assert.equal(proof.stage, 'context_with_system'); assert.equal(proof.section, 'context-broker-notion-catalog');
    assert.ok(proof.sequence < provider.sequence);
    for (const kind of ['input', 'output']) {
      assert.equal(hash(proof[kind + 'Section']), proof[kind + 'SectionSha256']);
      assert.equal(Buffer.byteLength(proof[kind + 'Section']), proof[kind + 'SectionBytes']);
    }
    assert.equal(binding.outputSectionSha256, proof.outputSectionSha256);
    assert.equal(binding.wireFragmentSha256, hash(proof.outputSection.trim()));
    assert.equal(binding.markerBytes, proof.markerBytes);
    const input = observation.find(event => event.phase === 'discovery-input-catalog' && event.sequence === proof.inputCatalogSequence);
    const actual = observation.find(event => event.phase === 'catalog' && event.sequence > proof.sequence && event.sequence < provider.sequence
      && event.providerPayloadSha256 === provider.observedPayloadSha256);
    assert.ok(input && actual, 'The input directory and actual provider must both be observed');
    assert.ok(input.sequence < proof.sequence && actual.sequence < provider.sequence);
    assert.equal(input.userTurn, proof.userTurn); assert.equal(actual.userTurn, proof.userTurn);
    assert.equal(input.systemPromptSha256, proof.inputSectionSha256);
    assert.equal(actual.state, input.state, 'Presentation cannot change pending/error into a complete empty directory');
    assert.equal(binding.inputCatalogSequence, input.sequence);
    assert.ok(observation.some(event => event.phase === 'provider-transport-start'
      && event.sequence > provider.sequence
      && event.observedPayloadSha256 === provider.observedPayloadSha256
      && /^[a-f0-9]{64}$/.test(event.wireBodySha256) && event.wireBodyBytes > 0), 'Experimental projection must reach actual HTTP');
    if (experiment.mode === 'full-cards') {
      assert.equal(proof.outputSection, proof.inputSection, 'Full cards are byte-exact');
      assert.equal(proof.outputMessagesSha256, proof.inputMessagesSha256); assert.equal(proof.markerBytes, 0);
    } else {
      assert.ok(!/<(?:skill|router)\b/.test(proof.outputSection), 'On-demand output cannot retain default cards');
      assert.ok(proof.outputSection.endsWith('Notion cards are on demand; discover them with notion_list.'));
      assert.equal(proof.markerBytes, Buffer.byteLength('\nNotion cards are on demand; discover them with notion_list.'));
    }
    assert.match(proof.preservedMessagesSha256, /^[a-f0-9]{64}$/);
    inputs.push(input);
  }
  return inputs;
}

/** Reuse the existing passive cost observer; graph transport independently
 * binds its exact provider bytes to HTTP. Source costs remain the original
 * whole-case SDK ledger, including startup, cancellation and resume. */
export function summarizeDiscoveryCosts({ events, observation, submission, setupIdentity }) {
  const identity = submission ?? setupIdentity;
  const providers = events.filter(event => event.phase === 'provider_request');
  const graph = observation.filter(event => event.phase === 'provider-request');
  const wires = observation.filter(event => event.phase === 'provider-transport-start');
  assert.equal(events[0]?.phase, 'observer_start'); assert.equal(events.at(-1)?.phase, 'observer_end');
  assert.equal(events.at(-1).complete, true); assert.equal(events.at(-1).errors, 0);
  assert.ok(!events.some(event => event.phase === 'observer_error'));
  assert.ok(identity && events.every(event => event.clockId === identity.clockId && event.sampleId === identity.sampleId));
  for (const [index, event] of events.entries()) {
    const { eventSha256, ...record } = event;
    assert.equal(event.sequence, index + 1, 'Cost event chain sequence changed');
    assert.equal(event.previousSha256, events[index - 1]?.eventSha256 ?? null, 'Cost event chain link changed');
    assert.equal(hash(JSON.stringify(record)), eventSha256, 'Cost event chain content changed');
  }
  if (!submission) {
    assert.ok(setupIdentity && !events.some(event => ['input', 'provider_request', 'tool_call'].includes(event.phase)
      || event.phase === 'message_end' && event.message?.role === 'assistant'), 'An unsubmitted setup cannot hide model work');
    assert.equal(graph.length, 0); assert.equal(wires.length, 0);
    assert.ok(!observation.some(event => event.phase?.startsWith('provider-')
      || ['native-input', 'authored-tool-call', 'tool-call', 'assistant-final'].includes(event.phase)), 'Unsubmitted setup needs a zero-model observation, not missing transport');
    return { method: 'existing-consumption-cost-observer-with-graph-http-binding', complete: true, task: 'not_run',
      providerRequests: 0, modelHttpAttempts: 0, modelHttpRequestBodyBytes: 0, modelHttpResponseBytes: null, tokens: null,
      sourceCosts: 'All startup source costs remain in the original whole-case ledger; no model request was submitted' };
  }
  assert.ok(events.some(event => event.phase === 'input' && event.text.sha256 === submission.promptSha256), 'Cost input must match the actual frozen submission');
  assert.deepEqual(providers.map(event => [event.payload.sha256, event.payload.bytes]), graph.map(event => [event.payloadSha256, event.payloadBytes]),
    'Cost measurements must describe the same verified provider inputs');
  assert.ok(wires.every(event => graph.some(request => request.observedPayloadSha256 === event.observedPayloadSha256)));
  assert.ok(graph.every(event => wires.some(wire => wire.observedPayloadSha256 === event.observedPayloadSha256)));
  const terminal = observation.filter(event => ['provider-transport-response', 'provider-transport-error'].includes(event.phase));
  assert.equal(terminal.length, wires.length, 'Every observed HTTP attempt needs a terminal response or error');
  const sum = values => values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    ? values.reduce((total, value) => total + value, 0) : null;
  const usage = new Map(events.filter(event => event.phase === 'message_end' && event.message?.role === 'assistant')
    .map(event => [event.request, event.message.usage]));
  const elapsed = event => {
    if (!event || !/^\d+$/.test(submission.monotonicNs) || !/^\d+$/.test(event.monotonicNs)) return null;
    const delta = BigInt(event.monotonicNs) - BigInt(submission.monotonicNs);
    assert.ok(delta >= 0n, 'Cost timestamps must share the submission clock');
    return Number(delta) / 1e6;
  };
  const spans = kind => providers.flatMap(event => event.payload.diagnosticSpans).filter(span => span.kind === kind);
  const projections = observation.filter(event => event.phase === 'discovery-projection');
  return { method: 'existing-consumption-cost-observer-with-graph-http-binding', complete: true,
    providerRequests: providers.length, providerJsonBytes: sum(providers.map(event => event.payload.bytes)),
    modelHttpAttempts: wires.length, modelHttpRequestBodyBytes: sum(wires.map(event => event.wireBodyBytes)), modelHttpResponseBytes: null,
    toolCalls: events.filter(event => event.phase === 'tool_call').length,
    toolRounds: new Set(events.filter(event => event.phase === 'tool_call').map(event => event.request)).size,
    schemaJsonBytes: sum(providers.flatMap(event => event.payload.components).filter(component => component.group === 'tools').map(component => component.bytes)),
    defaultCatalogUtf8Bytes: sum(spans('catalog').map(span => span.bytes)),
    availableSkillsUtf8Bytes: sum(spans('native-skill-directory').map(span => span.bytes)),
    guidanceUtf8Bytes: sum(spans('guidance').map(span => span.bytes)),
    projectedBodyUtf8Bytes: sum(spans('projected-body').map(span => span.bytes)),
    catalogInputSectionBytes: sum(projections.map(event => event.inputSectionBytes)),
    catalogOutputSectionBytes: sum(projections.map(event => event.outputSectionBytes)),
    noticeBytes: sum(projections.map(event => event.markerBytes)),
    diagnosticMethod: 'Nonadditive UTF-8 spans; do not sum nested spans or infer tokens from bytes',
    tokens: Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].map(key =>
      [key, providers.length ? sum(providers.map(event => usage.get(event.request)?.[key])) : null])),
    tokenMethod: 'Actual Pi assistant-reported usage; missing usage remains null',
    timings: { submitToFirstProviderMs: elapsed(providers[0]),
      submitToFirstEffectiveTextMs: elapsed(events.find(event => event.phase === 'message_update' && event.firstEffectiveText)),
      submitToCompletionMs: elapsed(events.filter(event => event.phase === 'agent_end').at(-1)) },
    observerWorkMs: events.at(-1).observerWorkMs,
    sourceCosts: 'Use the original whole-case sourceAccounting, without splitting or duplicating background SDK requests' };
}

export function assertIntentSource({ observation, responses, sourceLedger, hostLedger, scope, libraryId, catalogRecords,
  metadataOnly = false, selected = [], retainedSourceProofs = [] }) {
  const accounting = graphSourceAccounting(sourceLedger, responses, { sourceMode: 'sdk' });
  const cancelledCatalogs = [];
  for (const receipt of responses) {
    assert.equal(receipt.sdk_started, true); assert.equal(receipt.metrics_observed, true);
    if (receipt.status === 'cancelled') {
      assert.equal(receipt.resultObserved, false); assert.equal(receipt.value, null, 'Cancellation is not a completed catalog');
      const start = sourceLedger.find(row => row.phase === 'sdk-start' && row.requestId === receipt.requestId);
      const end = sourceLedger.find(row => row.phase === 'sdk-end' && row.requestId === receipt.requestId);
      const boundary = assertCatalogCancellationBoundary({ ...start, observer_pid: start?.pid }, { ...end, observer_pid: end?.pid },
        sourceLedger.filter(row => row.phase === 'native-session-shutdown').map(row => ({ ...row, type: 'session_shutdown' })));
      cancelledCatalogs.push({ requestId: receipt.requestId, pid: boundary.pid, monotonic_ns: boundary.monotonic_ns, countedAsReady: false });
    } else assert.equal(receipt.status, 'completed', 'Source failure remains a failed model observation');
    const attempts = receipt.metrics.trace.filter(event => event.event === 'attempt');
    assert.equal(attempts.length, receipt.metrics.total_requests, 'Every actual HTTP attempt must be retained');
    assert.equal(new Set(attempts.map(event => event.attempt)).size, attempts.length);
    assert.ok(attempts.every(event => Number.isSafeInteger(event.attempt) && event.attempt >= 1 && event.attempt <= attempts.length));
  }
  const attributed = graphSourceAttribution({ observation, responses, sourceLedger, scope, libraryId, selected, retainedSourceProofs });
  const attempts = attributed.attempts;
  const { directories, directoryFailures } = graphSourceViews(responses);
  assert.deepEqual(directoryFailures, [], 'Source projection failure remains a failed model observation');
  let defaultCatalog = 'not_observed_before_shutdown';
  if (catalogRecords) {
    const shape = records => records.map(record => [record.id, record.name, record.description, record.ref]).sort((a, b) => a[0].localeCompare(b[0]));
    const defaults = [];
    for (const { value } of directories) {
      assert.equal(value.scope, scope, 'Catalog scope must match the frozen source');
      assert.equal(value.count, value.records.length); assert.equal(new Set(value.records.map(record => record.id)).size, value.count);
      assert.ok(value.records.every(record => ['id', 'name', 'description', 'ref'].every(key => typeof record[key] === 'string')));
      assert.equal(value.coverage?.exhaustive, true); assert.deepEqual(value.coverage?.failed_sources, []);
      assert.equal(value.coverage?.search_index_limited, false);
      // A complete ordinary inventory may finish before the independent Default View request.
      const ordinary = value.coverage.method === 'explicit_database'
        && ['view', 'view_selection', 'view_query', 'profile', 'capability_directory'].every(key => !Object.hasOwn(value, key));
      if (ordinary) continue;
      assert.equal(value.coverage.method, 'explicit_view'); assert.equal(value.capability_directory, true);
      assert.ok(value.view && typeof value.view.id === 'string' && ['first', 'explicit'].includes(value.view_selection));
      assert.deepEqual(shape(value.records), shape(catalogRecords), 'Actual Default View metadata must match the frozen production directory');
      defaults.push(value);
    }
    if (defaults.length) defaultCatalog = 'observed_complete_production_default';
    else {
      const catalogs = observation.filter(event => event.phase === 'catalog' && event.stage === 'before_provider_request');
      assert.ok(metadataOnly && cancelledCatalogs.length > 0 && catalogs.length > 0 && catalogs.every(event => event.state === 'pending'),
        'Only pending chat may close before its Default View is observed');
      assert.ok(responses.every(receipt => receipt.operation === 'list'
        && receipt.metrics.trace.filter(event => event.event === 'attempt').every(event => event.request_kind === 'notion_metadata')),
      'An unobserved Default View cannot excuse source bodies, writes or unknown request kinds');
    }
  }
  assert.equal(attributed.missingMetrics, false);
  assert.equal(attributed.unattributedBeforeSelection, 0, 'Unknown source-body ownership remains observation-incomplete');
  assert.equal(attributed.memberBodyReadsBeforeSelection, 0, 'An unselected Member body was read');
  assert.ok(!attempts.some(event => event.kind === 'write'), 'Observed source writes require separate Records/business attribution; use does not automatically authorize them');
  const processes = hostLedger.filter(event => event.event === 'spawn');
  assert.ok(processes.length && processes.every(event => hostLedger.some(end => end.event === 'close' && end.pid === event.pid && end.observedExit)), 'Every actual Pi process must close');
  const sum = key => attempts.every(item => Number.isSafeInteger(item[key]) && item[key] >= 0)
    ? attempts.reduce((total, item) => total + item[key], 0) : null;
  return { ...accounting, httpAttempts: attempts, request_bytes: sum('requestBytes'), response_bytes: sum('responseBytes'),
    source_writes: attempts.filter(item => item.kind === 'write'), cancelled_catalogs: cancelledCatalogs, default_catalog: defaultCatalog,
    unselected_body_reads: 0, owned_processes_closed: processes.length };
}

async function checkedJson(reference) {
  assert.ok(isAbsolute(reference.path)); const bytes = await readFile(reference.path);
  assert.equal(hash(bytes), reference.sha256, 'Frozen private/source evidence changed');
  return JSON.parse(bytes.toString('utf8'));
}

export async function intentDoctor(path, selectedCase) {
  assert.ok(isAbsolute(path)); const config = await json(path), executionScope = selectIntentCases(config, selectedCase);
  const modelProfile = dailyRouteContract(config);
  const oracle = await checkedJson(config.privateOracle);
  const semantic = await checkedJson(config.privateOracle.semanticReference);
  const body = await readFile(semantic.sourceBody.path);
  assert.equal(hash(body), oracle.target.bodySha256); assert.equal(body.length, oracle.target.bodyBytes);
  assert.equal(semantic.sourceBody.sha256, oracle.target.bodySha256); assert.equal(semantic.sourceBody.bytes, oracle.target.bodyBytes);
  const catalog = await checkedJson(config.source.catalogEvidence);
  assert.equal(catalog.scope, config.source.catalogEvidence.scope);
  assert.equal(catalog.records.length, 74); assert.equal(new Set(catalog.records.map(item => item.id)).size, 74);
  assert.ok(catalog.records.some(record => record.id === oracle.target.logicalId));
  if (config.discoveryStartup) {
    assert.equal(catalog.capability_directory, true); assert.equal(catalog.view_selection, 'first');
    assert.ok(catalog.view?.id && catalog.view?.name); assert.equal(catalog.coverage?.exhaustive, true);
    assert.deepEqual(catalog.coverage?.failed_sources, []);
  }
  const artifacts = await installedBrokerIdentity(config.candidate.extension, config.candidate.packagePath);
  assert.equal(artifacts.extension.sha256, config.candidate.extensionSha256);
  assert.equal(artifacts.package.sha256, config.candidate.packageSha256);
  assert.equal(artifacts.runtimeSha256, config.candidate.runtimeSha256);
  for (const file of config.harness) assert.equal(hash(await readFile(file.path)), file.sha256, 'Frozen intent harness changed');
  const experiment = discoveryExperimentIdentity(config);
  if (experiment) {
    const costObserver = fileURLToPath(new URL('./skill-consumption-cost.mjs', import.meta.url));
    assert.ok(config.harness.some(file => file.path === costObserver), 'Freeze the existing cost observer for both discovery arms');
  }
  const host = await resolveHost(config.pi.path), version = (await runCommand(config.pi.path, ['--version'], { cwd: root, env: process.env, timeoutMs: 10000 })).stdout.trim();
  assertSupportedPiVersion(version); assert.equal(version, config.pi.version);
  assert.equal(hash(await readFile(host.identity)), config.pi.executableSha256);
  assert.ok(Array.isArray(config.cliCommand) && config.cliCommand.length === 2 && config.cliCommand.every(isAbsolute));
  assert.ok(isAbsolute(config.evidenceRoot)); await mkdir(config.evidenceRoot, { recursive: true });
  return { config, oracle, semantic, catalog, artifacts, host, executionScope, report: { status: 'ready', model: config.model, executionScope,
    ...(modelProfile ? { modelProfile } : {}),
    budget: config.budget, sourceMode: 'sdk', productionDefaultCount: 74, pi: { ...host, version },
    ...(experiment ? { phase: config.phase, discoveryExperiment: experiment, actualPublicProjection: 'not_run', experimentalAdoption: 'not_authorized' } : {}),
    ...(config.discoveryStartup ? { directoryStartup: { ...config.discoveryStartup, state: 'not_run', command: '/context-broker view',
      maxArmWallMs: 1200000, setupIncludedInArmWall: true, firstProvider: 'must independently observe ready metadata' } } : {}),
    artifacts, config: { path, sha256: hash(await readFile(path)) }, privateOracleSha256: config.privateOracle.sha256,
    semanticReferenceSha256: config.privateOracle.semanticReference.sha256,
    boundary: 'Read-only installed identity, private source and frozen budget inspection; no Notion or model request' } };
}

async function collectIntentResponses(directory) {
  return Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(name => json(join(directory, name))));
}

async function retainedFileInventory(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, item.name);
    if (item.isDirectory()) result.push(...await retainedFileInventory(directory, path));
    else result.push(path);
  }
  return result;
}

export async function runIntentCases(configPath, selectedCase) {
  const armStartedMs = performance.now(), armStartedAt = new Date().toISOString();
  const { config, oracle, semantic, catalog, artifacts, host, executionScope, report: doctor } = await intentDoctor(configPath, selectedCase);
  const modelProfile = dailyRouteContract(config);
  const evidence = await mkdtemp(join(await realpath(config.evidenceRoot), 'pi-intent-evidence-'));
  const manifest = { version: 1, kind: 'pi-model-intent-early-feedback', status: 'running', evidence,
    ...(modelProfile ? { modelProfile } : {}),
    model: config.model, budget: config.budget, executionScope, doctor, cases: [], submissions: 0, automaticRetries: 0,
    semanticOracle: { sourceBodySha256: semantic.sourceBody.sha256, reference: config.privateOracle.semanticReference },
    not_claimed: ['Formal SC21 matrix', 'Cost acceptance', 'Daily installation switch', 'Autonomous execution of the generated procedure'] };
  if (config.discoveryExperiment) {
    manifest.kind = 'pi-discovery-presentation-experiment';
    manifest.discoveryExperiment = discoveryExperimentIdentity(config);
    manifest.not_claimed.push('SC20 native Skill equivalence', 'Production adoption of the experimental presentation');
  }
  let stopActive = async () => {}, armTimedOut = false, armStop;
  const armRemaining = () => 1200000 - (performance.now() - armStartedMs);
  const armTimer = config.discoveryStartup ? setTimeout(() => {
    armTimedOut = true; armStop = stopActive().catch(error => { manifest.armStopError = error.message; });
  }, Math.max(1, armRemaining())) : undefined;
  if (config.discoveryStartup) manifest.directoryStartup = { ...config.discoveryStartup, startedAt: armStartedAt,
    maxArmWallMs: 1200000, accounting: 'All preparation, task and source-finality time shares the arm wall; setup prefix costs are not added twice' };
  try {
  await save(join(evidence, 'config.json'), config); await save(join(evidence, 'manifest.json'), manifest);
  console.log(JSON.stringify({ evidence, status: 'running', executionScope, primaryCases: executionScope.plannedBudget.primaryCases, maxSubmissions: executionScope.plannedBudget.maxSubmissions }));
  for (const item of config.cases.filter(item => executionScope.selectedCaseIds.includes(item.id))) {
    if (config.discoveryStartup && (armTimedOut || armRemaining() <= 0)) { armTimedOut = true; break; }
    const setupStartedMs = performance.now(), setupStartedAt = new Date().toISOString();
    const output = join(evidence, item.id); await mkdir(output);
    const scratch = await mkdtemp(join(await systemTempRoot(), 'broker-intent-model-'));
    const control = join(scratch, 'control'), cwd = join(scratch, 'workspace'), cliRoot = join(scratch, 'cli');
    const cache = join(scratch, 'broker'), sessions = join(scratch, 'sessions'), responsesPath = join(output, 'source-responses');
    const payloads = join(output, 'provider-requests'), ledger = join(output, 'source-processes.jsonl');
    const owned = join(output, 'owned-processes.jsonl'), observationPath = join(output, 'observer.jsonl');
    await Promise.all([control, cliRoot, cache, sessions, responsesPath, payloads].map(path => mkdir(path, { recursive: true })));
    assert.ok((await Promise.all([cliRoot, cache, sessions].map(path => readdir(path)))).every(items => items.length === 0));
    const oracleRoot = await realpath(dirname(config.privateOracle.path));
    assert.ok(!scratch.startsWith(oracleRoot + '/') && !oracleRoot.startsWith(scratch + '/'), 'Private oracle cannot warm a consumer root');
    const project = await createOwnedGraphProject(cwd, { modelProfile }); assert.equal(project.sha256, config.project.sha256);
    await Promise.all([ledger, owned, observationPath].map(path => writeFile(path, '', { mode: 0o600 })));
    const source = { type: 'notion', id: 'notion', namespace: 'notion', database: config.source.database,
      prefetch: false, cacheDir: cache, requestTimeoutMs: 60000 };
    const brokerConfig = join(control, 'broker.json'); await save(brokerConfig, { skillRoots: [], extraSkillRoots: [], sources: [source] });
    await save(join(output, 'source-config.json'), await json(brokerConfig));
    const hook = await sourceObserver(control, { ledger, responses: responsesPath, outputRoot: cache,
      cliEntries: [config.cliCommand[1], join(artifacts.packageRoot, 'dist/ntn-skills.mjs')] });
    const traps = await createGraphFallbackTraps(control, output);
    const env = { ...verificationCliEnvironment(cliRoot), ...traps.environment, NODE_OPTIONS: '--import=' + hook,
      ...(modelProfile ? { NTN_SKILLS_SCHEDULER_ROOT: join(cliRoot, 'request-engine') } : {}),
      CONTEXT_BROKER_CONFIG: brokerConfig, CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_LOG_FILE: join(output, 'decisions.jsonl'),
      BROKER_E2E_PROCESS_LEDGER: owned };
    const result = { version: 1, kind: 'pi-model-intent-case', sourceMode: 'sdk', toolContract: config.contract,
      ...(modelProfile ? { modelProfile, schedulerRoot: env.NTN_SKILLS_SCHEDULER_ROOT } : {}),
      gate: item.id, model: config.model, evidence: await realpath(output), scratch, project, status: 'running', executionScope,
      acceptance: 'technical_only_until_semantic_review', entryMode: item.entryMode, turns: [], files: [],
      prelaunch: { cli_entries: 0, broker_entries: 0, session_entries: 0, oracle_consumer_disjoint: true },
      sourceCommandConfigured: false, semanticReview: { status: 'pending', referenceSha256: config.privateOracle.semanticReference.sha256 } };
    if (config.discoveryExperiment) result.discoveryExperiment = { ...manifest.discoveryExperiment, costs: [] };
    if (config.discoveryStartup) result.directorySetup = { status: 'running', startedAt: setupStartedAt, timeoutMs: 60000,
      includedInArmWall: true, modelVisibility: 'not_yet_observed' };
    const owner = { evidence: result.evidence, purpose: 'native-graph-model', kind: 'pi-model-intent-case' };
    await save(join(scratch, 'ownership.json'), owner); await save(join(output, 'ownership.json'), owner);
    await save(join(output, 'project.json'), project); await save(join(output, 'result.json'), result);
    manifest.cases.push({ id: item.id, evidence: result.evidence, status: 'running' });
    let rpc, stopping, processIndex = 0, session, availabilityFailure = false, sourceComplete = false;
    const costRuns = [];
    const stop = async () => {
      if (!rpc) return stopping;
      const current = rpc; rpc = undefined;
      stopping = (async () => {
        try { await current.stop(); }
        finally { await save(join(output, 'rpc-' + processIndex + '.json'), current.frames); await save(join(output, 'lifecycle-' + processIndex + '.json'), current.lifecycle); }
      })();
      return stopping;
    };
    stopActive = stop;
    const boot = async () => {
      await stop(); processIndex++;
      await inspectOwnedGraphProject(cwd, { modelProfile });
      const sequenceOffset = Math.max(0, ...(await rows(observationPath)).map(event => event.sequence ?? 0));
      const observer = join(control, 'observer-' + processIndex + '.mjs'), module = join(control, 'graph-observer-' + processIndex + '.mjs');
      const settings = { sourceMode: 'sdk', entryMode: item.entryMode, ...(item.entryMode === 'explicit-root' ? { rootRef: oracle.roots.B.ref } : {}),
        ...(modelProfile ? { modelProfile } : {}),
        model: config.model, prompt: item.initial.text, cache, cwd, responses: responsesPath, payloads, output: observationPath,
        project, piExecutable: host.identity, sequenceOffset,
        ...(config.discoveryExperiment ? { discoveryExperiment: config.discoveryExperiment } : {}) };
      await writeFile(module, graphObserverModule(settings, pathToFileURL(join(dirname(config.candidate.extension), 'native-reference.ts')).href), { mode: 0o600 });
      await writeFile(observer, "import {appendFileSync} from 'node:fs';import {createHash} from 'node:crypto';export default api=>{api.on('input',event=>appendFileSync(" + JSON.stringify(observationPath)
        + ",JSON.stringify({phase:'native-input',at:new Date().toISOString(),textSha256:createHash('sha256').update(event.text??'').digest('hex')})+'\\n'));"
        + "api.on('session_shutdown',()=>appendFileSync(" + JSON.stringify(ledger)
        + ",JSON.stringify({phase:'native-session-shutdown',pid:process.pid,monotonic_ns:process.hrtime.bigint().toString(),at:new Date().toISOString()})+'\\n'));};\n", { mode: 0o600 });
      const args = ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates',
        '--session-dir', sessions, '--tools', 'read,notion_list,notion_use', '-e', observer, '-e', config.candidate.extension,
        '-e', module, '--model', config.model, ...(session ? ['--session', session] : [])];
      if (modelProfile) args.push('--thinking', modelProfile.thinkingLevel);
      let cost;
      if (config.discoveryExperiment) {
        cost = { processIndex, sequenceOffset, sampleId: item.id + '-' + processIndex, clockId: 'intent-' + process.pid,
          path: join(output, 'consumption-cost-' + processIndex + '.jsonl'), extension: join(control, 'consumption-cost-' + processIndex + '.mjs') };
        await writeFile(cost.extension, consumptionCostExtensionSource({ output: cost.path, checkoutRoot: root,
          runId: basename(evidence), sampleId: cost.sampleId, clockId: cost.clockId }), { mode: 0o600 });
        cost.extensionSha256 = hash(await readFile(cost.extension)); costRuns.push(cost);
        // Last passive observer measures the public projection without changing
        // provider input. Both experimental arms load the same observer.
        args.push('-e', cost.extension);
      }
      await save(join(output, 'launch-' + processIndex + '.json'), { host, args, cwd, source, observerSha256: hash(await readFile(observer)), graphObserverSha256: hash(await readFile(module)), sourceHookSha256: hash(await readFile(hook)),
        ...(modelProfile ? { modelProfile, schedulerRoot: env.NTN_SKILLS_SCHEDULER_ROOT, runtimeSettings: project.runtimeSettings } : {}),
        ...(cost ? { consumptionCostObserver: cost } : {}) });
      const deadline = { armStartedMs, stageStartedMs: processIndex === 1 ? setupStartedMs : performance.now(),
        stageLimitMs: processIndex === 1 ? 60000 : 300000, stop };
      if (config.discoveryStartup) discoveryAllowance({ ...deadline, nowMs: performance.now() });
      // The 60-second setup stage must not shorten later model submissions in
      // this same RPC process. The outer stage race enforces setup separately.
      const timeoutMs = config.discoveryStartup ? Math.ceil(Math.min(300000, armRemaining())) : 300000;
      rpc = await startRpc({ host: config.pi.path, cwd, env, args, timeoutMs,
        ...(config.discoveryStartup ? { waitForState: false } : {}) });
      const state = config.discoveryStartup ? await withinDiscoveryBudget(() => rpc.command('get_state'), deadline) : await rpc.command('get_state');
      await save(join(output, 'state-' + processIndex + '.json'), state);
      if (modelProfile) {
        await appendFile(observationPath, JSON.stringify({ phase: 'model-state', at: new Date().toISOString(), processIndex,
          state: { model: { provider: state.model?.provider, id: state.model?.id }, thinkingLevel: state.thinkingLevel } }) + '\n', { mode: 0o600 });
        verifyDailyRouteState(modelProfile, state);
      }
    };
    try {
      await boot();
      if (config.discoveryStartup) {
        Object.assign(result.directorySetup, await waitForDiscoveryReady({ rpc, catalog, armStartedMs, setupStartedMs, stop,
          snapshot: async () => {
            const sourceLedger = await rows(ledger);
            const responses = await Promise.all(sourceLedger.filter(row => row.phase === 'sdk-end').map(row => json(join(responsesPath, row.responseFile))));
            return { sourceLedger, responses, observation: await rows(observationPath) };
          }, savePoll: poll => save(join(output, 'directory-setup-poll-' + poll.index + '.json'), poll) }));
        result.directorySetup.finishedAt = new Date().toISOString();
        await save(join(output, 'directory-setup.json'), result.directorySetup);
      }
      const turns = [{ intent: item.intent, prompt: item.initial, mode: 'initial' }, ...item.followups];
      for (const [index, turn] of turns.entries()) {
        if (turn.mode === 'restart-and-resume-same-session') await boot();
        if (config.discoveryStartup) discoveryAllowance({ armStartedMs, stageStartedMs: performance.now(), stageLimitMs: 300000, nowMs: performance.now() });
        const currentRpc = rpc;
        const before = (await rows(observationPath)).length, priorResponses = await collectIntentResponses(responsesPath);
        const beforeIds = new Set(priorResponses.map(row => row.requestId)), began = performance.now(), frameStart = currentRpc.frames.length;
        const receipt = { index, intent: turn.intent, prompt: turn.prompt, mode: turn.mode, status: 'running', processIndex };
        result.turns.push(receipt); manifest.submissions++;
        assert.ok(manifest.submissions <= executionScope.plannedBudget.maxSubmissions, 'Frozen maximum selected submissions exceeded');
        await save(join(evidence, 'manifest.json'), manifest); await save(join(output, 'result.json'), result);
        try {
          if (config.discoveryExperiment) {
            const cost = costRuns.at(-1);
            assert.equal(cost.submission, undefined, 'The D experiment uses one submission per original process lifecycle');
            cost.submission = { sampleId: cost.sampleId, clockId: cost.clockId, monotonicNs: process.hrtime.bigint().toString(),
              promptSha256: turn.prompt.sha256, index };
            receipt.costSubmission = cost.submission;
            await save(join(output, 'cost-submission-' + processIndex + '.json'), cost.submission);
          }
          let promptError;
          try {
            if (config.discoveryStartup) await withinDiscoveryBudget(() => currentRpc.prompt(turn.prompt.text),
              { armStartedMs, stageStartedMs: began, stageLimitMs: 300000, stop });
            else await currentRpc.prompt(turn.prompt.text);
          } catch (error) { promptError = error; throw error; }
          finally {
            try {
              // Retain the actual output before acceptance can reject this turn.
              const final = (await rows(observationPath)).slice(before).filter(event => event.phase === 'assistant-final').at(-1);
              if (final) {
                receipt.final = { ...final, ...(typeof final.text === 'string' ? { sha256: hash(final.text), bytes: Buffer.byteLength(final.text) } : {}) };
                await save(join(output, 'turn-' + index + '.json'), receipt);
              }
            } catch (error) {
              receipt.finalEvidenceError = { code: error.code ?? 'FINAL_EVIDENCE_FAILED', message: error.message };
              if (!promptError) throw error;
            }
          }
          const observation = await rows(observationPath), turnObservation = observation.slice(before);
          assert.ok(turnObservation.some(event => event.phase === 'native-input' && event.textSha256 === turn.prompt.sha256), 'Actual native input must match the frozen prompt');
          const responses = await collectIntentResponses(responsesPath);
          Object.assign(receipt, assertIntentTurn({ observation, turnObservation, responses,
            newResponses: responses.filter(row => !beforeIds.has(row.requestId)), item, intent: turn.intent,
            oracle, catalogRecords: catalog.records, followup: index > 0, discoveryExperiment: config.discoveryExperiment, discoveryStartup: config.discoveryStartup, modelProfile }));
          const state = config.discoveryStartup ? await withinDiscoveryBudget(() => currentRpc.command('get_state'),
            { armStartedMs, stageStartedMs: began, stageLimitMs: 300000, stop }) : await currentRpc.command('get_state');
          session = state.sessionFile;
          assert.ok(session, 'An actual session file is required for continuation');
          receipt.session = session;
        } catch (error) {
          receipt.status = 'failed'; receipt.error = { code: error.code ?? 'INTENT_TURN_FAILED', message: error.message };
          if (modelProfile && ['MODEL_STATE', 'MODEL_ROUTE_EVIDENCE'].includes(error.code)) result.modelContractFailure ??= receipt.error;
        }
        receipt.elapsedMs = performance.now() - began;
        receipt.providerUsage = currentRpc.frames.slice(frameStart).filter(frame => frame.type === 'message_end' && frame.message?.role === 'assistant').map(frame => frame.message.usage ?? null);
        const turnEvents = (await rows(observationPath)).slice(before);
        if (config.discoveryStartup && index === 0) {
          try { result.directorySetup.firstProvider = assertReadyDiscoveryProvider({ observation: turnEvents,
            catalogRecords: catalog.records, scope: oracle.target.scope, experiment: config.discoveryExperiment }); }
          catch (error) { result.directorySetup.firstProvider = { status: 'failed', error: error.message }; }
          await save(join(output, 'directory-setup.json'), result.directorySetup);
        }
        receipt.availabilityFailure = modelAvailabilityFailure(turnEvents.map(event => ({ ...event,
          phase: event.phase === 'provider-transport-response' ? 'response' : event.phase === 'assistant-final' ? 'assistant_final'
            : event.phase === 'tool-call' ? 'tool_call' : event.phase })));
        availabilityFailure ||= receipt.availabilityFailure;
        await save(join(output, 'turn-' + index + '.json'), receipt);
        if (receipt.status !== 'passed') break;
      }
    } catch (error) {
      result.error = { code: error.code ?? 'INTENT_HOST_FAILED', message: error.message };
      if (modelProfile && ['MODEL_STATE', 'MODEL_ROUTE_EVIDENCE'].includes(error.code)) result.modelContractFailure ??= result.error;
      if (result.directorySetup?.status === 'running') {
        Object.assign(result.directorySetup, { status: 'failed', error: result.error, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - setupStartedMs,
          task: 'not_run', modelVisibility: 'not_observed' });
        await save(join(output, 'directory-setup.json'), result.directorySetup);
      }
    }
    finally {
      try { await stop(); }
      catch (error) {
        const failure = { code: 'HOST_FINALITY_FAILED', message: error.message };
        result.error ??= failure;
        if (config.discoveryStartup || modelProfile) result.hostFinality = { status: 'failed', error: failure };
      }
    }
    const observation = await rows(observationPath), responses = await collectIntentResponses(responsesPath), sourceLedger = await rows(ledger), hostLedger = await rows(owned);
    if (config.discoveryStartup) {
      result.notRunTurns = [{ intent: item.intent, prompt: item.initial, mode: 'initial' }, ...item.followups]
        .slice(result.turns.length).map((turn, index) => ({ index: result.turns.length + index, intent: turn.intent, status: 'not_run',
          reason: result.directorySetup.status === 'failed' ? 'directory_setup_failed' : 'failed_prerequisite_or_arm_deadline' }));
      try {
        const attempts = responses.flatMap(receipt => receipt.metrics?.trace?.filter(event => event.event === 'attempt') ?? []);
        const sum = key => responses.every(receipt => receipt.metrics?.complete) && attempts.every(event => Number.isSafeInteger(event[key]) && event[key] >= 0)
          ? attempts.reduce((total, event) => total + event[key], 0) : null;
        result.wholeCaseSourceCosts = { ...graphSourceAccounting(sourceLedger, responses, { sourceMode: 'sdk' }),
          requestBytes: sum('request_bytes'), responseBytes: sum('response_bytes'),
          accounting: 'Includes directory setup and task once; attribution is established separately by sourceAccounting' };
      } catch (error) { result.wholeCaseSourceCosts = { complete: false, error: error.message, requestBytes: null, responseBytes: null }; }
    }
    if (config.discoveryExperiment) {
      try {
        for (const [index, cost] of costRuns.entries()) {
          assert.ok(cost.submission || config.discoveryStartup && result.directorySetup.status === 'failed',
            'A started experimental process must have its original submission receipt or an explicit failed setup');
          const observed = await readConsumptionCostEvents(cost.path), through = costRuns[index + 1]?.sequenceOffset ?? Infinity;
          const summary = summarizeDiscoveryCosts({ events: observed.events, submission: cost.submission,
            ...(cost.submission ? {} : { setupIdentity: { sampleId: cost.sampleId, clockId: cost.clockId } }),
            observation: observation.filter(event => event.sequence > cost.sequenceOffset && event.sequence <= through) });
          const receipt = { processIndex: cost.processIndex, submission: cost.submission,
            events: { path: cost.path, ...observed.artifact }, ...summary };
          result.discoveryExperiment.costs.push(receipt);
          await save(join(output, 'discovery-cost-' + cost.processIndex + '.json'), receipt);
        }
        result.discoveryExperiment.costStatus = 'complete';
      } catch (error) {
        result.discoveryExperiment.costStatus = 'incomplete';
        result.discoveryExperiment.costError = { code: 'DISCOVERY_COST_EVIDENCE_FAILED', message: error.message };
        result.error ??= result.discoveryExperiment.costError;
      }
    }
    try {
      const selected = item.entryMode === 'explicit-root' ? oracle.preparations.B.map(row => ({ id: row.logicalId })) : [];
      const common = { observation, responses, sourceLedger, hostLedger, scope: oracle.target.scope,
        libraryId: oracle.target.logicalId.split(':')[1], catalogRecords: catalog.records, metadataOnly: item.intent === 'chat', selected };
      let attribution = graphSourceAttribution(common);
      await save(join(output, 'source-attribution-before-proof.json'), attribution);
      // This existing collector has a 120-second cap. Do not launch it if its
      // complete allowance no longer fits inside the opt-in arm wall.
      const proofBudgetAvailable = !config.discoveryStartup || armRemaining() >= 120000;
      const supplementary = await collectSupplementaryRetainedProof({ config: { gate: item.id,
        ...(modelProfile ? { modelProfile } : {}), retainedSourceProofRepo: proofBudgetAvailable ? config.retainedSourceProofRepo : undefined },
        evidence: output, trace: { httpAttempts: attribution.attempts }, responses, ownershipResponses: responses });
      if (!proofBudgetAvailable && supplementary.receipt.status === 'not-configured')
        Object.assign(supplementary.receipt, { status: 'not_run', reason: 'insufficient_remaining_arm_wall', ownership: 'unknown' });
      result.retainedSourceObservation = supplementary.receipt;
      result.sourceAccounting = assertIntentSource({ ...common, retainedSourceProofs: supplementary.proof ? [supplementary.proof] : [] });
      sourceComplete = true;
      assert.equal((await rows(traps.ledger)).length, 0, 'Legacy fallback was invoked');
      await inspectOwnedGraphProject(cwd, { modelProfile });
      assert.ok(!result.error && result.turns.length === 1 + item.followups.length && result.turns.every(turn => turn.status === 'passed'));
      result.status = 'passed';
      if (item.intent === 'produce-and-exercise-artifact') {
        result.generatedPlan = await retainGeneratedPlan({ evidence: output, final: result.turns[0].final, prompt: item.initial, project });
        assert.equal(result.generatedPlan.artifactStatus, 'complete-skill-files-retained', 'Plan-only is not a generated verification Skill');
        result.generatedExercise = { status: 'waiting-for-independent-exercise',
          reason: 'The controller must review complete generated bytes and an exact Node invocation before exercising an independent owned project copy; command text is not execution evidence' };
      }
    } catch (error) {
      result.status = 'failed'; result.error = { code: error.code ?? 'INTENT_EVIDENCE_FAILED', message: error.message };
    }
    if (modelProfile) {
      result.sharedTechnicalFailure = intentTechnicalFailure({ result, sourceComplete, observation });
      if (!config.discoveryStartup) result.notRunTurns = [{ intent: item.intent, prompt: item.initial, mode: 'initial' }, ...item.followups]
        .slice(result.turns.length).map((turn, index) => ({ index: result.turns.length + index, intent: turn.intent, status: 'not_run',
          reason: result.sharedTechnicalFailure ? 'shared_technical_failure' : 'failed_prerequisite' }));
    }
    result.semanticReview.status = result.status === 'passed' ? 'pending' : 'blocked_by_technical_failure';
    result.finishedAt = new Date().toISOString();
    result.files = [...new Set([...(await retainedFileInventory(output)), 'result.json'])];
    await save(join(output, 'result.json'), result);
    Object.assign(manifest.cases.at(-1), { status: result.status, semanticReview: result.semanticReview.status, turns: result.turns.length, error: result.error });
    await save(join(evidence, 'manifest.json'), manifest);
    if (modelProfile && !config.discoveryStartup && result.sharedTechnicalFailure) manifest.stoppedAfterTechnicalFailure = item.id;
    if (availabilityFailure) { manifest.availabilityFailure = true; break; }
    if (manifest.stoppedAfterTechnicalFailure || config.discoveryStartup && (armTimedOut || armRemaining() <= 0 || discoveryTechnicalFailure({ result, sourceComplete, observation }))) {
      manifest.stoppedAfterTechnicalFailure = item.id; break;
    }
  }
  } finally { clearTimeout(armTimer); await armStop; }
  if (config.discoveryStartup) {
    const elapsedMs = performance.now() - armStartedMs;
    Object.assign(manifest.directoryStartup, { elapsedMs, finishedAt: new Date().toISOString(), timedOut: armTimedOut || elapsedMs > 1200000,
      closureOverrunMs: Math.max(0, elapsedMs - 1200000) });
    manifest.notRunCases = [...executionScope.notRunCases, ...executionScope.selectedCaseIds.filter(id => !manifest.cases.some(item => item.id === id))
      .map(id => ({ id, status: 'not_run', reason: 'prior_technical_failure_or_arm_deadline' }))];
  }
  else if (modelProfile) manifest.notRunCases = [...executionScope.notRunCases,
    ...executionScope.selectedCaseIds.filter(id => !manifest.cases.some(item => item.id === id)).map(id => ({ id, status: 'not_run',
      reason: manifest.stoppedAfterTechnicalFailure ? 'shared_technical_failure' : 'model_unavailable' }))];
  manifest.status = intentRunStatus(executionScope, manifest.cases);
  if (manifest.directoryStartup?.timedOut) manifest.status = 'failed';
  await save(join(evidence, 'manifest.json'), manifest);
  return manifest;
}

export function validateIntentReview(review, manifest, results, semantic) {
  assert.equal(review.version, 1); assert.equal(review.evidence, manifest.evidence);
  assert.equal(review.configSha256, manifest.doctor.config.sha256);
  assert.equal(review.semanticReferenceSha256, manifest.semanticOracle.reference.sha256);
  assert.ok(typeof review.reviewer === 'string' && review.reviewer.trim());
  const expected = results.flatMap(result => result.turns.filter(turn => turn.status === 'passed').map(turn => ({ result, turn })));
  assert.equal(review.turns.length, expected.length, 'Review every technically completed actual final');
  const keys = new Set();
  for (const row of review.turns) {
    const key = row.caseId + '/' + row.index; assert.ok(!keys.has(key)); keys.add(key);
    const value = expected.find(value => value.result.gate === row.caseId && value.turn.index === row.index);
    assert.ok(value, 'Review cannot invent a successful model submission');
    assert.equal(row.finalSha256, value.turn.final.sha256);
    assert.equal(hash(value.turn.final.text), row.finalSha256);
    assert.ok(['passed', 'failed'].includes(row.verdict)); assert.ok(typeof row.reason === 'string' && row.reason.trim());
    for (const field of ['intentRespected', 'sourceSupported', 'noUnsupportedExecutionClaims']) assert.equal(typeof row[field], 'boolean');
    assert.ok(Array.isArray(row.contradictions) && Array.isArray(row.omittedNecessaryFacts));
    if (row.caseId === 'C-introduce' || row.caseId === 'D-named-introduce') {
      assert.equal(row.sourceBodySha256, semantic.sourceBody.sha256);
      assert.ok(Array.isArray(row.supportingSpans) && row.supportingSpans.length > 0);
      for (const span of row.supportingSpans) {
        assert.ok(semantic.facts.some(fact => fact.id === span.fact));
        assert.ok(Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start);
        assert.equal(value.turn.final.text.slice(span.start, span.end), span.text, 'Semantic review must point to the actual answer, not a rewritten explanation');
      }
    }
    if (row.verdict === 'passed') {
      assert.equal(row.intentRespected, true); assert.equal(row.sourceSupported, true); assert.equal(row.noUnsupportedExecutionClaims, true);
      assert.equal(row.contradictions.length, 0); assert.equal(row.omittedNecessaryFacts.length, 0);
    }
  }
  return { status: review.turns.every(row => row.verdict === 'passed') ? 'passed' : 'failed', reviewedTurns: review.turns.length,
    boundary: 'Explicit independent semantic assessment of hash-bound real answers; no regex substitutes for meaning, and review cannot manufacture source delivery or actions' };
}

export async function verifyIntentGeneratedExercises(review, results) {
  const receipts = [];
  for (const result of results.filter(result => result.gate === 'D-natural-task' && result.status === 'passed')) {
    const row = review.turns.find(row => row.caseId === result.gate && row.index === 0);
    if (row?.verdict === 'passed') receipts.push(await verifyGeneratedExerciseAcceptance(result, row.generatedExercise));
  }
  return receipts;
}

export async function reviewIntentCases(configPath, evidence, reviewPath, selectedCase) {
  assert.ok(isAbsolute(evidence) && isAbsolute(reviewPath));
  const { config, semantic, executionScope, report: doctor } = await intentDoctor(configPath, selectedCase);
  const manifest = await json(join(evidence, 'manifest.json'));
  assert.equal(manifest.doctor.config.sha256, doctor.config.sha256);
  assert.deepEqual(manifest.executionScope ?? selectIntentCases(config), executionScope, 'Review must bind the original explicit selection');
  const results = await Promise.all(manifest.cases.map(item => json(join(item.evidence, 'result.json'))));
  const modelProfile = dailyRouteContract(config);
  assert.deepEqual(manifest.modelProfile, modelProfile, 'Review must bind the frozen model contract');
  assert.deepEqual(manifest.doctor.modelProfile, modelProfile);
  for (const result of results) assert.deepEqual(result.modelProfile, modelProfile);
  const review = await json(reviewPath), verdict = validateIntentReview(review, manifest, results, semantic);
  const generatedExercises = await verifyIntentGeneratedExercises(review, results);
  await writeFile(join(evidence, 'manifest-before-review.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await save(join(evidence, 'semantic-review.json'), review);
  manifest.semanticReview = { ...verdict, path: reviewPath, sha256: hash(await readFile(reviewPath)), generatedExercises };
  manifest.status = intentRunStatus(executionScope, manifest.cases, verdict.status);
  await save(join(evidence, 'manifest.json'), manifest);
  return manifest;
}

export function requestCounts(events) {
  const starts = events.filter(row => row.phase === 'started');
  const remote = events.filter(row => row.kind === 'http' && row.phase === 'attempt' && row.request_kind !== 'provider');
  const body = remote.filter(row => row.request_kind === 'notion_body');
  const writes = remote.filter(row => row.request_kind === 'notion_write');
  const complete = starts.filter(row => row.kind === 'cli').every(row => events.some(receipt => receipt.kind === 'metrics' && receipt.phase === 'metrics' && receipt.requestId === row.requestId && receipt.observed === true && receipt.complete === true));
  return { complete, cli: starts.filter(row => row.kind === 'cli').length, reads: starts.filter(row => row.kind === 'cli' && row.command === 'read').length, exports: starts.filter(row => row.kind === 'cli' && row.command === 'export').length, notion: remote.length, notionBody: body.length, notionWrites: writes.length };
}

export function cacheCaseDirectory(scratch, evidence, name) {
  assert.ok(isAbsolute(scratch) && isAbsolute(evidence) && /^[a-z0-9-]+$/.test(name));
  return join(scratch, 'runs', basename(evidence), name);
}

export function modelAvailabilityFailure(events) {
  const responses = events.filter(event => event.phase === 'response');
  const final = events.filter(event => event.phase === 'assistant_final').at(-1);
  const status = responses.find(event => [401, 402, 403, 404, 429, 503].includes(event.status))?.status;
  const notice = final?.text && /(?:requires? (?:a )?premium|premium (?:license|subscription)|license (?:is )?required|insufficient (?:credits|quota)|model (?:is )?(?:unavailable|not available|not found)|模型.{0,16}(?:不可用|无权限)|余额不足)/i.test(final.text);
  return Boolean(status || notice && !events.some(event => event.phase === 'tool_call'));
}

export function assertModelCase(events, expected, { native = false, explicit = false, cold = false, warm = false, coldCli = false, warmBroker = false, revalidated = false, expectedSnapshot, requestEvents = [], graphEvents, surface = 'public-tools', toolContract = 'agent-cli-ref-20261105' } = {}) {
  assert.ok(['agent-cli-ref-20261105', 'legacy-pi-tools'].includes(toolContract), 'Unknown model cache tool contract');
  assert.ok(['native-read-only', 'public-tools'].includes(surface), 'Unknown frozen model cache surface');
  const requests = events.filter(row => row.phase === 'request');
  const finals = events.filter(row => row.phase === 'assistant_final' && row.success && row.bytes > 0);
  const toolResults = events.filter(row => row.phase === 'tool_result');
  const counts = requestCounts(requestEvents);
  assert.equal(counts.complete, true, 'Every driven CLI operation must retain a complete HTTP attempt ledger; missing metrics do not prove zero requests');
  assert.ok(requests.length && events.some(row => row.phase === 'response' && row.status >= 200 && row.status < 300), 'Actual provider request and HTTP success required');
  assert.ok(finals.length, 'Successful nonempty real-model final required');
  const final = finals.at(-1);
  for (const token of expected) assert.ok(final.text.includes(token), `Final answer must use the selected source value: ${token}`);
  assert.ok(requests.every(row => row.skillBodies <= 1), 'Repeated loading must never duplicate the instruction body');
  assert.ok(requests.some(row => row.skillBodies === 1), 'Provider must receive the selected instruction body');
  assert.ok(requests.some(row => row.resourceBodies > 0), 'Provider must consume actual resource bytes, including a retained prior tool result');
  assert.ok(requests.every(row => Array.isArray(row.completeContents)), 'Every actual provider request must retain complete-file byte/hash receipts');
  assert.ok(requests.every(row => row.completeContents.filter(item => item.role === 'entrypoint').reduce((sum, item) => sum + item.copies, 0) <= 1), 'Complete main instruction bytes must remain a single provider copy');
  assert.ok(requests.some(row => row.completeContents.some(item => item.role === 'entrypoint' && item.copies === 1 && item.manifestComplete)), 'Provider must receive the complete verified main, not only its marker');
  assert.ok(requests.some(row => row.completeContents.some(item => item.role === 'resource' && item.copies > 0 && item.manifestComplete)), 'Provider must receive a complete verified resource file');
  assert.ok(!toolResults.some(row => row.isError), 'A claimed pass cannot hide a failed selected-resource read');
  assert.ok(!toolResults.some(row => row.proofMismatch), 'A claimed pass cannot hide a mismatched source delivery proof');
  assert.ok(!events.some(row => row.phase === 'tool_call' && row.allowed === false), 'A claimed pass cannot hide a blocked out-of-scope read');
  if (graphEvents !== undefined) {
    const provider = graphEvents.filter(row => row.phase === 'provider-request');
    assert.ok(!graphEvents.some(row => row.phase === 'observer-error'), 'The paired public-tool observer contract must not fail');
    assert.equal(provider.length, requests.length, 'Every provider request needs the paired public-tool observer');
    const expectedTools = surface === 'native-read-only' ? ['read'] : toolContract === 'legacy-pi-tools' ? ['read', 'skill_prepare', 'skill_search'] : ['notion_list', 'notion_use', 'read'];
    assert.ok(requests.every(row => JSON.stringify([...row.tools].sort()) === JSON.stringify(expectedTools)), 'Actual provider tools must match the predeclared case surface');
    assert.ok(provider.every(row => JSON.stringify([...row.tools].sort()) === JSON.stringify(expectedTools)), 'The actual provider must advertise the frozen legal read-only tools');
    assert.ok(!graphEvents.some(row => row.phase === 'tool-call' && row.allowed !== true), 'A claimed pass cannot hide a blocked or unauthored public tool');
    const returned = graphEvents.filter(row => ['metadata-result', 'preparation-result', 'tool-result'].includes(row.phase));
    assert.ok(returned.every(row => row.complete === true), 'Every public tool result must pass its actual CLI/manifest/delivery proof');
    for (const result of returned.filter(row => row.phase === 'metadata-result')) assert.ok(provider.some(row => row.toolResults.some(tool => {
      if (tool.toolCallId !== result.toolCallId || tool.sha256 !== result.sha256 || tool.bytes !== result.bytes) return false;
      const projections = tool.metadataProjections ?? [];
      if (!Array.isArray(projections)) return false;
      if (tool.exactToolOutputCopies === 1) return projections.length === 0;
      if (toolContract !== 'agent-cli-ref-20261105' || result.tool !== 'notion_list' || tool.tool !== 'notion_list'
        || tool.exactToolOutputCopies !== 0 || projections.length !== 1) return false;
      const projection = projections[0];
      // The paired graph observer verifies every omitted description against a
      // complete card in this same payload; retain its distinct delivery receipt.
      return projection.sourceSha256 === result.sha256 && projection.sourceBytes === result.bytes
        && /^[a-f0-9]{64}$/u.test(projection.sha256) && projection.sha256 !== result.sha256
        && Number.isSafeInteger(projection.bytes) && projection.bytes > 0
        && Array.isArray(projection.descriptionReuse) && projection.descriptionReuse.length > 0
        && projection.descriptionReuse.every(evidence => ['actual-default-card', 'actual-discovery-card', 'complete-generated-directory'].includes(evidence.origin)
          && /^sr:C[A-Za-z0-9_-]{22}$/u.test(evidence.ref) && typeof evidence.description === 'string');
    })), 'Metadata must reach the provider as one complete actual native tool output or one independently verified metadata projection');
    const useTool = toolContract === 'legacy-pi-tools' ? 'skill_prepare' : 'notion_use';
    for (const result of returned.filter(row => row.phase === 'tool-result' && ['skill_prepare', 'notion_use'].includes(row.tool))) {
      assert.equal(result.tool, useTool, 'Fresh and historical tool contracts cannot be mixed');
      assert.equal(result.origin, 'model'); assert.equal(result.preparationProof?.deliveryVerified, true); assert.equal(result.preparationProof.explicitRoot, true);
      assert.ok(provider.some(row => row.toolResults.some(tool => tool.toolCallId === result.toolCallId && tool.records.some(record => record.ref === result.ref && record.scope === result.scope && record.sha256 === result.sha256 && record.bytes === result.bytes && record.providerCopies === 1))), 'A prepared root must reach the actual provider as one complete verified body');
    }
  }
  if (expectedSnapshot) {
    assert.ok(toolResults.filter(row => row.receiptValidated).every(row => row.snapshot === expectedSnapshot), 'Entry and resources must use the expected fixed snapshot, regardless of the final answer');
    assert.ok(requests.flatMap(row => row.completeContents).every(row => row.snapshot === expectedSnapshot), 'Complete provider files must use the expected fixed snapshot');
  }
  if (native) {
    assert.equal(requests[0].skillBodies, 0, 'Autonomous first request must see metadata, not a pre-injected body');
    assert.ok(toolResults.some(row => row.kind === 'skill' && row.role === 'entrypoint' && row.bodyMatchesFile && row.receiptValidated), 'Model must choose and successfully read the exact native entry');
  }
  if (explicit) assert.equal(requests[0].skillBodies, 1, 'Explicit dollar/native activation must finish before the first provider request');
  if (cold) {
    assert.ok(counts.notionBody > 0, 'Empty CLI/Broker caches must produce an actual Notion body read');
    assert.ok(counts.exports > 0 || requests.some(row => row.completeContents.some(item => item.materialization === 'entry' && item.manifestComplete)), 'Cold content needs a verified complete export or an explicit complete-manifest entry materialization');
  }
  if (warm) assert.equal(counts.notionBody, 0, 'Warm content reuse must not download Notion bodies');
  if (coldCli) assert.ok(counts.notionBody > 0, 'An empty CLI cannot claim a verified current body from a Broker directory alone');
  if (warmBroker) assert.equal(counts.exports, 0, 'An already verified immutable Broker export should not be exported again');
  if (revalidated) assert.ok(counts.notion > 0, 'Expired current state must actually revalidate Notion');
  assert.equal(counts.notionWrites, 0, 'Ordinary host loading must not mutate the pre-initialized fixture');
  return { requests: counts, providerRequests: requests.length, completeProviderContents: requests.map(row => row.completeContents), skillReads: toolResults.filter(row => row.kind === 'skill' && row.bodyMatchesFile).length, resourceReads: toolResults.filter(row => row.resourceSuccess).length, snapshots: [...new Set([...toolResults.map(row => row.snapshot), ...requests.flatMap(row => row.completeContents.map(item => item.snapshot))].filter(Boolean))], final: { text: final.text, textSha256: final.textSha256, stopReason: final.stopReason, usage: final.usage } };
}

export async function runMatrix(options) {
  const targetedCase = options.case;
  if (targetedCase !== undefined) {
    assert.equal(targetedCase, 'cold-native-command', '--case supports only the independent cold-native-command case');
    assert.equal(options.resume, undefined, '--case and --resume are mutually exclusive');
    assert.equal(options['resume-case'], undefined, '--case cannot select a resumed session');
  }
  const fixture = await json(options.fixture);
  assert.ok(['magpie/group/flash-free', 'magpie/group/worker'].includes(options.model), 'Use one of the explicitly authorized model selectors');
  for (const key of ['fixture', 'extension', 'package-path', 'cli', 'evidence-root']) assert.ok(isAbsolute(options[key] ?? ''), `${key} must be absolute`);
  let previousFailure;
  if (options.model === 'magpie/group/worker') {
    assert.ok(isAbsolute(options['previous-failure'] ?? ''), 'Worker requires this final package\'s retained actual flash-free availability failure');
    const prior = await json(options['previous-failure']);
    assert.equal(prior.model, 'magpie/group/flash-free'); assert.equal(prior.status, 'failed'); assert.equal(prior.availabilityFailure, true);
    assert.equal(prior.extensionSha256, hash(await readFile(options.extension))); assert.equal(prior.cliSha256, hash(await readFile(options.cli)));
    previousFailure = { path: await realpath(options['previous-failure']), sha256: hash(await readFile(options['previous-failure'])) };
  } else assert.equal(options['previous-failure'], undefined, 'Flash-free runs do not inherit a fallback failure');
  assert.ok(fixture.record?.locator?.type === 'shared_skill' && fixture.record.enabled && fixture.expected?.length === 4 && fixture.resourceContent && fixture.marker);
  const evidence = await mkdtemp(join(options['evidence-root'], 'pi-cache-evidence-'));
  const scratch = options.resume ? (await json(join(options.resume, 'manifest.json'))).scratch : await mkdtemp(join(await realpath(tmpdir()), 'pi-model-cache-'));
  const phase = options.resume ? 'updated' : targetedCase ? 'targeted' : 'initial';
  if (!options.resume) await save(join(scratch, 'ownership.json'), { evidence });
  else assert.equal((await json(join(scratch, 'ownership.json'))).evidence, options.resume);
  const manifest = { version: 1, status: 'running', sourceMode: 'command', toolContract: 'agent-cli-ref-20261105', phase, ...(targetedCase ? { targeted: { case: targetedCase, expectedCases: 1, initialSuiteCases: 11 } } : {}), evidence, scratch, resumeCase: options['resume-case'] ?? 'cold-autonomous-native', model: options.model, previousFailure, availabilityFailure: false, fixture: options.fixture, runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))), extension: options.extension, extensionSha256: hash(await readFile(options.extension)), cli: options.cli, cliSha256: hash(await readFile(options.cli)), cases: [], notRun: ['Default bundled SDK source transport', 'OMP/Tern', 'native visual composer interactions', 'provider server-side cache control'], boundary: 'Real installed Pi and Broker with an explicit custom CLI source command, project direct HTTP attempt ledger, real model; source/model credentials consumed in place and never copied. Oracle roots are never used as consumer roots.' };
  manifest.installedBroker = await installedBrokerIdentity(options.extension, options['package-path']);
  const piExecutable = (await resolveHost('pi')).identity;
  manifest.piHelpBoundary = { executable: piExecutable, helperSha256: hash(await readFile(new URL('./notion-pi-help.mjs', import.meta.url))) };
  await save(join(evidence, 'manifest.json'), manifest);
  console.log(JSON.stringify({ evidence, scratch, phase, model: options.model }));
  const ledgerFile = join(evidence, 'owned-processes.jsonl');
  await writeFile(ledgerFile, '', { mode: 0o600 });
  // Keep the effective source command byte-for-byte stable across an A/B
  // continuation. Replacing a tracing wrapper changes model-visible CLI
  // guidance and is not part of a native content update.
  const requestsRoot = join(scratch, 'initial-requests');
  let ledger, publicResponses;
  const publicHelper = fileURLToPath(new URL('./notion-skill-graph-model.mjs', import.meta.url));
  if (options.resume) {
    const commandFile = join(requestsRoot, 'source-ledger.json'), cfg = await json(commandFile);
    const originalStates = await json(join(options.resume, 'states.json'));
    const originalState = originalStates[manifest.resumeCase];
    assert.ok(originalState?.base?.startsWith(scratch + '/'), 'Resume case must belong to the original owned scratch');
    const originalConfig = await json(join(originalState.base, 'broker-initial.json'));
    const originalCommand = originalConfig.sources?.[0]?.command;
    assert.deepEqual(originalCommand, [process.execPath, fileURLToPath(new URL('./notion-default-context.mjs', import.meta.url)), '--request-ledger', commandFile]);
    const publicConfig = join(requestsRoot, 'public-source.json'), captured = await json(publicConfig);
    assert.deepEqual(cfg.command, [process.execPath, publicHelper, '--source', publicConfig], 'Resumed public capture command must remain unchanged');
    assert.deepEqual(captured.command, [process.execPath, options.cli], 'Resumed source command must select the same installed CLI');
    publicResponses = captured.responses;
    assert.equal(cfg.ledger, join(options.resume, 'safe-source-requests.jsonl'));
    assert.equal(await realpath(commandFile), commandFile);
    ledger = { command: originalCommand, ledger: cfg.ledger };
  } else {
    await mkdir(requestsRoot, { recursive: true, mode: 0o700 });
    publicResponses = join(evidence, 'public-responses'); await mkdir(publicResponses);
    const publicConfig = join(requestsRoot, 'public-source.json');
    await save(publicConfig, { command: [process.execPath, options.cli], cliPaths: {}, responses: publicResponses, ledger: join(evidence, 'public-cli-processes.jsonl') });
    ledger = await createRequestLedger({ scratch: requestsRoot, evidence, command: [process.execPath, publicHelper, '--source', publicConfig] });
  }
  const phaseLedgerStart = (await rows(ledger.ledger)).length;
  manifest.requestLedger = { path: ledger.ledger, firstRow: phaseLedgerStart, stableCommand: ledger.command, publicResponses, publicHelperSha256: hash(await readFile(publicHelper)) };
  const selector = fixture.record.id;
  const selected = { selector, physicalSelector: fixture.record.locator.page_id, locator: fixture.record.locator, id: selector, kind: fixture.record.kind, entry: fixture.record.entrypoint, ref: fixture.record.ref };
  const prompt = `请使用 ${fixture.alias} 工作流。实际读取附带的 ${fixture.resource}，只报告当前已选版本的工作流修订、检查表修订、发布闸门、证据代号，再用一句话解释结论。不要猜测版本，不执行任何写入。`;
  const invocation = `$${fixture.alias}@notion ${prompt}`;
  const nativeName = `notion-${fixture.alias}`.replace(/[^a-z0-9-]/g, '-');
  let active;
  const states = options.resume ? (await json(join(options.resume, 'states.json'))) : {};
  const stop = async () => { if (active) { const value = active; active = undefined; await value.rpc.stop(); } };
  async function boot(name, { cliRoot, cache, sessionDir, session, maxAge, newSession = true, bodyMarker = fixture.marker } = {}) {
    await stop();
    assert.deepEqual(await installedBrokerIdentity(options.extension, options['package-path']), manifest.installedBroker, 'Installed Broker runtime changed during the matrix');
    const base = cacheCaseDirectory(scratch, evidence, name);
    await mkdir(base, { recursive: true, mode: 0o700 });
    cliRoot ??= join(base, 'cli'); cache ??= join(base, 'broker-cache'); sessionDir ??= join(base, 'sessions');
    const cliExistedBeforeHost = await access(cliRoot).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    await mkdir(cache, { recursive: true, mode: 0o700 }); const brokerEntriesBeforeHost = (await readdir(cache)).length; await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const config = join(base, 'broker-' + phase + '.json');
    await save(config, { sources: [{ type: 'notion', id: 'notion', namespace: 'notion', command: ledger.command, database: fixture.database, default_view_id: fixture.view, prefetch: false, cacheDir: cache, requestTimeoutMs: 30000, ...(maxAge ? { activation: { maxAge }, discovery: { maxAge } } : {}) }] });
    const capture = join(evidence, name + '-observer.jsonl');
    await writeFile(capture, '', { mode: 0o600 });
    const graphCapture = join(evidence, name + '-public-tool-observer.jsonl'); await writeFile(graphCapture, '', { mode: 0o600 });
    const surfaceFile = join(base, 'frozen-tool-surface.json'); await save(surfaceFile, { surface: 'public-tools' });
    const slash = options.model.indexOf('/');
    const settings = { model: options.model, provider: options.model.slice(0, slash), id: options.model.slice(slash + 1), marker: bodyMarker, alias: fixture.alias, selected, cache: await realpath(cache), cwd: base, output: capture, expectedResourceBodies: [fixture.resourceContent], publicGraph: true, surfaceFile };
    if (options.resume) settings.expectedResourceBodies.push((await json((await json(join(options.resume, 'manifest.json'))).fixture)).resourceContent);
    const observer = join(base, 'model-observer-' + phase + '.mjs');
    const graphSettings = { sourceMode: 'command', model: options.model, rootRef: selected.ref, cache: settings.cache, cwd: base, responses: publicResponses, output: graphCapture, toolSurfaceFile: surfaceFile, piExecutable };
    const graphObserver = join(base, 'public-tool-observer-' + phase + '.mjs');
    await writeFile(graphObserver, graphObserverModule(graphSettings, pathToFileURL(join(dirname(options.extension), 'native-reference.ts')).href), { mode: 0o600 });
    await writeFile(observer, `import * as fs from 'node:fs';import * as crypto from 'node:crypto';import * as path from 'node:path';import observePublicTools from ${JSON.stringify(pathToFileURL(graphObserver).href)};export default api=>{const piHelpBoundary=(${createPiHelpBoundary.toString()})({fs,path,crypto,executable:${JSON.stringify(piExecutable)}});observePublicTools(api);(${observe.toString()})(api,{...${JSON.stringify(settings)},fs,crypto,path,piHelpBoundary});};\n`, { mode: 0o600 });
    const env = { ...verificationCliEnvironment(cliRoot), CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_LOG_FILE: join(evidence, name + '-decisions.jsonl'), BROKER_E2E_PROCESS_LEDGER: ledgerFile };
    const args = ['--no-extensions', '--no-skills', '--session-dir', sessionDir, '--no-mcp', '--no-context-files', '--no-prompt-templates', '--tools', 'read,notion_list,notion_use', '-e', options.extension, '-e', observer, '--model', options.model, ...(session ? ['--session', session] : [])];
    const startupAt = Date.now();
    const rpc = await startRpc({ host: 'pi', cwd: base, env, args, timeoutMs: 300000 });
    const state = await rpc.command('get_state');
    active = { rpc, base, cliRoot, cache, sessionDir, capture, graphCapture, surfaceFile, state, env, name, newSession, cliExistedBeforeHost, brokerEntriesBeforeHost, startupMs: Date.now() - startupAt, firstTurn: true };
    return active;
  }
  async function turn(name, message, policy = {}, expected = fixture.expected) {
    assert.ok(active, 'A real host must be running');
    const surface = name === 'cold-autonomous-native' ? 'native-read-only' : 'public-tools';
    await save(active.surfaceFile, { surface, case: name, reason: surface === 'native-read-only' ? 'AH560 original case 1 explicitly requires autonomous native read; AH574 read-only degraded entry' : 'Normal registered read, metadata search and explicit preparation surface' });
    if (policy.coldCli || policy.cold) assert.equal(active.cliExistedBeforeHost, false, 'Cold case must allocate a new CLI root, including after a prior failed run');
    const frameBefore = active.rpc.frames.length;
    const obsBefore = (await rows(active.capture)).length, graphBefore = (await rows(active.graphCapture)).length, traceBefore = (await rows(ledger.ledger)).length, started = Date.now();
    const result = { name, status: 'running', model: options.model, session: active.state.sessionFile ?? null, cacheRoot: active.cache, cliRoot: active.cliRoot, prelaunch: { cliRootExisted: active.cliExistedBeforeHost, brokerRootEntries: active.brokerEntriesBeforeHost }, policy, toolSurface: await json(active.surfaceFile), startupMs: active.firstTurn ? active.startupMs : 0, startedAt: new Date(started).toISOString() };
    manifest.cases.push(result); await save(join(evidence, 'manifest.json'), manifest);
    try {
      await active.rpc.prompt(message);
      const events = (await rows(active.capture)).slice(obsBefore), requests = (await rows(ledger.ledger)).slice(traceBefore);
      const graphEvents = (await rows(active.graphCapture)).slice(graphBefore);
      Object.assign(result, assertModelCase(events, expected, { expectedSnapshot: fixture.snapshot, explicit: message.startsWith('$') || message.startsWith('/skill:'), ...policy, requestEvents: requests, graphEvents, surface }), { status: 'passed' });
      const state = await active.rpc.command('get_state');
      result.session = state.sessionFile; assert.ok(result.session, 'Real Pi must return an actual session file');
      states[name] = { base: active.base, cliRoot: active.cliRoot, cache: active.cache, sessionDir: active.sessionDir, session: state.sessionFile, expected, snapshots: result.snapshots };
      await save(join(evidence, 'states.json'), states);
    } catch (error) {
      result.status = 'failed'; result.error = error?.code === 'ERR_ASSERTION' ? error.message : 'Real host/provider execution failed; raw diagnostic withheld';
      result.availabilityFailure = modelAvailabilityFailure((await rows(active.capture)).slice(obsBefore));
      result.failureKind = result.availabilityFailure ? 'model_availability' : error?.code === 'ERR_ASSERTION' ? 'assertion' : 'host_or_provider';
      if (result.availabilityFailure) manifest.availabilityFailure = true;
    }
    result.elapsedMs = Date.now() - started; result.startupAndTurnMs = result.elapsedMs + result.startupMs; active.firstTurn = false;
    result.hostDiagnostics = active.rpc.frames.slice(frameBefore).filter(frame => ['extension_error', 'error'].includes(frame.type)).map(frame => ({ type: frame.type, code: typeof frame.code === 'string' && /^[A-Z_]+$/.test(frame.code) ? frame.code : undefined }));
    await save(join(evidence, name + '-result.json'), result); await save(join(evidence, 'manifest.json'), manifest);
    console.log(JSON.stringify(result));
    if (result.availabilityFailure) throw Object.assign(new Error('Actual authorized model is unavailable; preserve this failed sample before considering the permitted fallback'), { code: 'MODEL_UNAVAILABLE' });
    return result.status === 'passed';
  }
  try {
    if (phase === 'targeted') {
      await boot('cold-native-command'); await turn('cold-native-command', `/skill:${nativeName} ${prompt}`, { cold: true });
    } else if (phase === 'initial') {
      const first = await boot('autonomous');
      assert.equal(first.cliExistedBeforeHost, false, 'Cold CLI root must not exist before host launch');
      assert.equal(first.brokerEntriesBeforeHost, 0, 'Broker cache must be empty before host launch');
      if (await turn('cold-autonomous-native', prompt, { native: true, cold: true })) {
        await turn('same-session-repeat', '沿用当前已加载的工作流和检查表，重新报告四项原始值；无需重复读取已知内容。', { warm: true });
        await turn('same-session-native-switch', `/skill:${nativeName} 沿用当前版本，报告四项原始值。`, { warm: true });
        await stop();
        await boot('warm-new-process', { cliRoot: first.cliRoot, cache: first.cache });
        await turn('warm-new-process', invocation, { warm: true });
        const original = states['cold-autonomous-native'];
        await boot('resumed-original', { cliRoot: first.cliRoot, cache: first.cache, sessionDir: original.sessionDir, session: original.session });
        await turn('persisted-session-resume', invocation, { warm: true });
      }
      await boot('cold-dollar'); await turn('cold-dollar', invocation, { cold: true });
      await boot('cold-native-command'); await turn('cold-native-command', `/skill:${nativeName} ${prompt}`, { cold: true });
      if (states['cold-autonomous-native']) {
        const original = states['cold-autonomous-native'];
        await boot('expired-unchanged', { cliRoot: original.cliRoot, cache: original.cache, maxAge: '0' });
        await turn('explicit-revalidation-unchanged', invocation, { revalidated: true });
        await boot('cli-warm-broker-empty', { cliRoot: original.cliRoot });
        await turn('cli-warm-broker-empty', invocation, { warm: true });
        await boot('broker-warm-cli-empty', { cache: original.cache });
        await turn('broker-warm-cli-empty', invocation, { coldCli: true, warmBroker: true });
        await boot('short-ttl-expired', { cliRoot: original.cliRoot, cache: original.cache, maxAge: '1s' });
        await new Promise(done => setTimeout(done, 1100));
        await turn('elapsed-short-ttl-revalidation', invocation, { revalidated: true });
      }
    } else {
      const original = states[manifest.resumeCase]; assert.ok(original?.snapshots?.length, 'Updated phase requires a successful original cold case with a verified snapshot');
      const originalFixture = await json((await json(join(options.resume, 'manifest.json'))).fixture);
      await boot('old-session-after-edit', { cliRoot: original.cliRoot, cache: original.cache, sessionDir: original.sessionDir, session: original.session, bodyMarker: originalFixture.marker });
      await turn('old-session-pinned-after-edit', invocation, { warm: true, expectedSnapshot: original.snapshots[0] }, original.expected);
      await boot('fresh-session-after-edit', { cliRoot: original.cliRoot, cache: original.cache, maxAge: '0' });
      if (await turn('refreshed-new-session-b', invocation, {})) {
        const current = states['refreshed-new-session-b'];
        assert.ok(current.snapshots.length && !current.snapshots.some(snapshot => original.snapshots.includes(snapshot)), 'Refreshed B must select a new snapshot');
        await boot('warm-b-new-process', { cliRoot: original.cliRoot, cache: original.cache });
        await turn('warm-b-new-process', invocation, { warm: true });
        await boot('resumed-b', { cliRoot: original.cliRoot, cache: original.cache, sessionDir: current.sessionDir, session: current.session });
        await turn('resumed-b', invocation, { warm: true });
        await boot('broker-warm-cli-empty-b', { cache: original.cache });
        await turn('broker-warm-cli-empty-b', invocation, { coldCli: true, warmBroker: true });
        await boot('short-ttl-expired-b', { cliRoot: original.cliRoot, cache: original.cache, maxAge: '1s' });
        await new Promise(done => setTimeout(done, 1100));
        await turn('elapsed-short-ttl-revalidation-b', invocation, { revalidated: true });
      }
    }
    manifest.status = manifest.cases.length && manifest.cases.every(item => item.status === 'passed') ? 'passed' : 'failed';
  } catch (error) {
    manifest.status = 'failed'; manifest.error = error?.code === 'ERR_ASSERTION' ? error.message : 'Runner/host did not complete; retained per-case evidence identifies the last step.';
  } finally {
    try { await stop(); } catch { manifest.status = 'failed'; manifest.shutdownError = true; }
    const processes = await rows(ledgerFile), started = processes.filter(row => row.event === 'spawn');
    manifest.processes = { started: started.length, missingExit: started.filter(row => !processes.some(end => end.event === 'close' && end.pid === row.pid && end.observedExit)).map(row => row.pid) };
    if (manifest.processes.missingExit.length) manifest.status = 'failed';
    await writeFile(join(evidence, 'phase-source-requests.jsonl'), (await rows(ledger.ledger)).slice(phaseLedgerStart).map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    await save(join(evidence, 'manifest.json'), manifest);
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) console.log('Usage: node scripts/verify-pi-notion-model-cache.mjs --fixture ABSOLUTE_JSON --extension INSTALLED_EXTENSION --package-path EXACT_INSTALLED_TGZ --cli INSTALLED_CLI --model magpie/group/flash-free|magpie/group/worker --evidence-root ABSOLUTE_DIRECTORY [--previous-failure ABSOLUTE_FLASH_FREE_MANIFEST (required for worker)] [--case cold-native-command | --resume INITIAL_EVIDENCE --resume-case ORIGINAL_CASE]. --case runs one independent cold case with phase targeted, not the initial eleven-case suite, and cannot be combined with resume options. C/D early feedback: --intent-config ABSOLUTE_FROZEN_JSON [--intent-case C-introduce|D-early] [--intent-action doctor|run|review --intent-evidence ABSOLUTE_RUN --intent-review ABSOLUTE_REVIEW_JSON]. By default run keeps all four n1 cases and at most three necessary follow-ups. Explicit selection still validates the complete four-case config. C-introduce keeps its two original conditional follow-ups and records all D cases as not_run; D-early keeps the three original D cases and one conditional follow-up, with C not_run. Technical success remains review_required until a private hash-bound semantic review; either successful targeted selection remains partial overall. Repeat the same --intent-case for doctor, run and review. Each case reuses the original graph evidence/cleanup commands. Original case 1 freezes the native-read-only degraded entry; every other case enables read, notion_list and notion_use under agent-cli-ref-20261105. This retained matrix explicitly uses a custom CLI command source and does not certify default bundled SDK transport. Initial phase uses separate empty CLI/Broker roots; resume phase verifies a separately approved owned remote edit without changing user configuration. An actual model availability failure stops that matrix and remains retained; assertions never authorize fallback.');
  else {
    while (args.length) { const key = args.shift(); assert.ok(['--fixture', '--extension', '--package-path', '--cli', '--model', '--evidence-root', '--previous-failure', '--case', '--resume', '--resume-case', '--intent-config', '--intent-action', '--intent-evidence', '--intent-review', '--intent-case'].includes(key) && args.length, 'Unknown option or missing value'); assert.ok(options[key.slice(2)] === undefined, 'Repeated option'); options[key.slice(2)] = args.shift(); }
    if (options['intent-case'] !== undefined) assert.ok(options['intent-config'], '--intent-case requires --intent-config');
    if (options['intent-config']) {
      assert.ok(Object.keys(options).every(key => ['intent-config', 'intent-action', 'intent-evidence', 'intent-review', 'intent-case'].includes(key)), 'Intent and legacy custom-source options cannot be mixed');
      const action = options['intent-action'] ?? 'run'; assert.ok(['doctor', 'run', 'review'].includes(action));
      const result = action === 'doctor' ? (await intentDoctor(options['intent-config'], options['intent-case'])).report
        : action === 'review' ? await reviewIntentCases(options['intent-config'], options['intent-evidence'], options['intent-review'], options['intent-case'])
        : await runIntentCases(options['intent-config'], options['intent-case']);
      console.log(JSON.stringify({ status: result.status, evidence: result.evidence, executionScope: result.executionScope, doctor: action === 'doctor' ? result : undefined }));
      if (result.status === 'failed') process.exitCode = 1;
    } else {
      const result = await runMatrix(options); console.log(JSON.stringify({ status: result.status, evidence: result.evidence, passed: result.cases.filter(item => item.status === 'passed').length, total: result.cases.length })); if (result.status !== 'passed') process.exitCode = 1;
    }
  }
}
