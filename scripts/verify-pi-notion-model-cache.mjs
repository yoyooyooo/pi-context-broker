#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost, runCommand, assertSupportedPiVersion } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { createRequestLedger } from './notion-default-context.mjs';
import { observe } from './notion-integration-model.mjs';
import { graphObserverModule, sourceObserver, graphSourceAttribution, collectSupplementaryRetainedProof, createGraphFallbackTraps } from './notion-skill-graph-model.mjs';
import { graphSourceViews, graphSourceAccounting } from './notion-skill-graph-model-evidence.mjs';
import { createOwnedGraphProject, inspectOwnedGraphProject, retainGeneratedPlan, exerciseGeneratedProcedure } from './notion-skill-graph-project.mjs';
import { createPiHelpBoundary } from './notion-pi-help.mjs';
import { installedBrokerIdentity } from './notion-skill-graph-session.mjs';
import { verificationCliEnvironment, systemTempRoot } from './verification-paths.mjs';
import { assertCatalogCancellationBoundary } from './notion-sdk-pi.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const rows = async path => { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const hash = value => createHash('sha256').update(value).digest('hex');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function validateIntentConfiguration(config) {
  assert.equal(config.version, 1); assert.equal(config.contract, 'agent-cli-ref-20261105');
  assert.equal(config.phase, 'early-feedback-not-formal-SC21');
  assert.equal(config.model, 'magpie/group/flash-free'); assert.equal(config.fallback, 'forbidden');
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
  if (selectedCase !== undefined) assert.ok(['C-introduce', 'D-early'].includes(selectedCase), 'Only the explicitly authorized C-introduce or D-early selection is supported');
  const selected = config.cases.filter(item => selectedCase === undefined || (selectedCase === 'D-early' ? item.id !== 'C-introduce' : item.id === selectedCase));
  const followups = selected.reduce((count, item) => count + item.followups.length, 0), submissions = selected.length + followups;
  return { mode: selectedCase === undefined ? 'all' : 'targeted', selectedCaseIds: selected.map(item => item.id),
    notRunCases: config.cases.filter(item => !selected.includes(item)).map(item => ({ id: item.id, status: 'not_run', reason: 'not_selected_for_early_feedback' })),
    plannedBudget: { ...config.budget, primaryCases: selected.length, maxFollowupSubmissions: followups,
      maxSubmissions: submissions, maxScheduledPromptMs: submissions * config.budget.timeoutMsPerSubmission } };
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

const exactFile = (file, expected) => file.ownerId === expected.logicalId && file.scope === expected.scope
  && file.snapshot === expected.snapshot && file.sha256 === expected.sha256 && file.bytes === expected.bytes
  && (expected.ref === undefined || file.ref === expected.ref);

export function assertIntentTurn({ observation, turnObservation = observation, responses, newResponses = responses,
  item, intent = item.intent, oracle, catalogRecords, followup = false }) {
  const providers = turnObservation.filter(event => event.phase === 'provider-request');
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
  for (const current of catalog) {
    if (current.state === 'pending') { assert.equal(followup, false, 'An ordinary continuation must expose ready metadata'); continue; }
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
  const targetUses = views.preparations.filter(row => row.value.purpose === 'use' && row.value.nodes.some(node => node.id === oracle.target.logicalId));
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
    if (intent === 'reuse-introduction') assert.equal(newResponses.filter(row => row.operation !== 'list').length, 0, 'Ordinary reuse cannot silently read or prepare bodies again');
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
  return { status: 'passed', acceptance: 'technical_only', final: { ...final, sha256: hash(final.text) },
    provider_requests: providers.length, provider_input_bytes: providers.reduce((sum, item) => sum + item.payloadBytes, 0),
    tool_calls: turnObservation.filter(event => event.phase === 'tool-call').length,
    catalog_states: catalog.map(event => event.state), semantic_review: 'required' };
}

export function assertIntentSource({ observation, responses, sourceLedger, hostLedger, scope, libraryId, catalogRecords,
  metadataOnly = false, selected = [], retainedSourceProofs = [] }) {
  const accounting = graphSourceAccounting(sourceLedger, responses, { sourceMode: 'sdk' });
  const cancelledCatalogs = [];
  for (const receipt of responses) {
    assert.equal(receipt.sdk_started, true); assert.equal(receipt.metrics_observed, true);
    if (receipt.status === 'cancelled') {
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
  const directories = graphSourceViews(responses).directories;
  let defaultCatalog = 'not_observed_before_shutdown';
  if (catalogRecords) {
    const shape = records => records.map(record => [record.id, record.name, record.description, record.ref]).sort((a, b) => a[0].localeCompare(b[0]));
    const matching = directories.find(row => row.value.scope === scope && JSON.stringify(shape(row.value.records)) === JSON.stringify(shape(catalogRecords)));
    if (matching) defaultCatalog = 'observed_complete_production_default';
    else assert.ok(metadataOnly && cancelledCatalogs.length > 0 && directories.length === 0, 'Actual default SDK metadata must match the frozen production directory');
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
  const oracle = await checkedJson(config.privateOracle);
  const semantic = await checkedJson(config.privateOracle.semanticReference);
  const body = await readFile(semantic.sourceBody.path);
  assert.equal(hash(body), oracle.target.bodySha256); assert.equal(body.length, oracle.target.bodyBytes);
  assert.equal(semantic.sourceBody.sha256, oracle.target.bodySha256); assert.equal(semantic.sourceBody.bytes, oracle.target.bodyBytes);
  const catalog = await checkedJson(config.source.catalogEvidence);
  assert.equal(catalog.scope, config.source.catalogEvidence.scope);
  assert.equal(catalog.records.length, 74); assert.equal(new Set(catalog.records.map(item => item.id)).size, 74);
  assert.ok(catalog.records.some(record => record.id === oracle.target.logicalId));
  const artifacts = await installedBrokerIdentity(config.candidate.extension, config.candidate.packagePath);
  assert.equal(artifacts.extension.sha256, config.candidate.extensionSha256);
  assert.equal(artifacts.package.sha256, config.candidate.packageSha256);
  assert.equal(artifacts.runtimeSha256, config.candidate.runtimeSha256);
  for (const file of config.harness) assert.equal(hash(await readFile(file.path)), file.sha256, 'Frozen intent harness changed');
  const host = await resolveHost(config.pi.path), version = (await runCommand(config.pi.path, ['--version'], { cwd: root, env: process.env, timeoutMs: 10000 })).stdout.trim();
  assertSupportedPiVersion(version); assert.equal(version, config.pi.version);
  assert.equal(hash(await readFile(host.identity)), config.pi.executableSha256);
  assert.ok(Array.isArray(config.cliCommand) && config.cliCommand.length === 2 && config.cliCommand.every(isAbsolute));
  assert.ok(isAbsolute(config.evidenceRoot)); await mkdir(config.evidenceRoot, { recursive: true });
  return { config, oracle, semantic, catalog, artifacts, host, executionScope, report: { status: 'ready', model: config.model, executionScope,
    budget: config.budget, sourceMode: 'sdk', productionDefaultCount: 74, pi: { ...host, version },
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
  const { config, oracle, semantic, catalog, artifacts, host, executionScope, report: doctor } = await intentDoctor(configPath, selectedCase);
  const evidence = await mkdtemp(join(await realpath(config.evidenceRoot), 'pi-intent-evidence-'));
  const manifest = { version: 1, kind: 'pi-model-intent-early-feedback', status: 'running', evidence,
    model: config.model, budget: config.budget, executionScope, doctor, cases: [], submissions: 0, automaticRetries: 0,
    semanticOracle: { sourceBodySha256: semantic.sourceBody.sha256, reference: config.privateOracle.semanticReference },
    not_claimed: ['Formal SC21 matrix', 'Cost acceptance', 'Daily installation switch', 'Autonomous execution of the generated procedure'] };
  await save(join(evidence, 'config.json'), config); await save(join(evidence, 'manifest.json'), manifest);
  console.log(JSON.stringify({ evidence, status: 'running', executionScope, primaryCases: executionScope.plannedBudget.primaryCases, maxSubmissions: executionScope.plannedBudget.maxSubmissions }));
  for (const item of config.cases.filter(item => executionScope.selectedCaseIds.includes(item.id))) {
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
    const project = await createOwnedGraphProject(cwd); assert.equal(project.sha256, config.project.sha256);
    await Promise.all([ledger, owned, observationPath].map(path => writeFile(path, '', { mode: 0o600 })));
    const source = { type: 'notion', id: 'notion', namespace: 'notion', database: config.source.database,
      prefetch: false, cacheDir: cache, requestTimeoutMs: 60000 };
    const brokerConfig = join(control, 'broker.json'); await save(brokerConfig, { skillRoots: [], extraSkillRoots: [], sources: [source] });
    await save(join(output, 'source-config.json'), await json(brokerConfig));
    const hook = await sourceObserver(control, { ledger, responses: responsesPath, outputRoot: cache,
      cliEntries: [config.cliCommand[1], join(artifacts.packageRoot, 'dist/ntn-skills.mjs')] });
    const traps = await createGraphFallbackTraps(control, output);
    const env = { ...verificationCliEnvironment(cliRoot), ...traps.environment, NODE_OPTIONS: '--import=' + hook,
      CONTEXT_BROKER_CONFIG: brokerConfig, CONTEXT_BROKER_HOST: 'pi', CONTEXT_BROKER_LOG_FILE: join(output, 'decisions.jsonl'),
      BROKER_E2E_PROCESS_LEDGER: owned };
    const result = { version: 1, kind: 'pi-model-intent-case', sourceMode: 'sdk', toolContract: config.contract,
      gate: item.id, model: config.model, evidence: await realpath(output), scratch, project, status: 'running', executionScope,
      acceptance: 'technical_only_until_semantic_review', entryMode: item.entryMode, turns: [], files: [],
      prelaunch: { cli_entries: 0, broker_entries: 0, session_entries: 0, oracle_consumer_disjoint: true },
      sourceCommandConfigured: false, semanticReview: { status: 'pending', referenceSha256: config.privateOracle.semanticReference.sha256 } };
    const owner = { evidence: result.evidence, purpose: 'native-graph-model', kind: 'pi-model-intent-case' };
    await save(join(scratch, 'ownership.json'), owner); await save(join(output, 'ownership.json'), owner);
    await save(join(output, 'project.json'), project); await save(join(output, 'result.json'), result);
    manifest.cases.push({ id: item.id, evidence: result.evidence, status: 'running' });
    let rpc, processIndex = 0, session, availabilityFailure = false;
    const stop = async () => {
      if (!rpc) return;
      const current = rpc; rpc = undefined;
      try { await current.stop(); }
      finally { await save(join(output, 'rpc-' + processIndex + '.json'), current.frames); await save(join(output, 'lifecycle-' + processIndex + '.json'), current.lifecycle); }
    };
    const boot = async () => {
      await stop(); processIndex++;
      const sequenceOffset = Math.max(0, ...(await rows(observationPath)).map(event => event.sequence ?? 0));
      const observer = join(control, 'observer-' + processIndex + '.mjs'), module = join(control, 'graph-observer-' + processIndex + '.mjs');
      const settings = { sourceMode: 'sdk', entryMode: item.entryMode, ...(item.entryMode === 'explicit-root' ? { rootRef: oracle.roots.B.ref } : {}),
        model: config.model, prompt: item.initial.text, cache, cwd, responses: responsesPath, payloads, output: observationPath,
        project, piExecutable: host.identity, sequenceOffset };
      await writeFile(module, graphObserverModule(settings, pathToFileURL(join(dirname(config.candidate.extension), 'native-reference.ts')).href), { mode: 0o600 });
      await writeFile(observer, "import {appendFileSync} from 'node:fs';import {createHash} from 'node:crypto';export default api=>{api.on('input',event=>appendFileSync(" + JSON.stringify(observationPath)
        + ",JSON.stringify({phase:'native-input',at:new Date().toISOString(),textSha256:createHash('sha256').update(event.text??'').digest('hex')})+'\\n'));"
        + "api.on('session_shutdown',()=>appendFileSync(" + JSON.stringify(ledger)
        + ",JSON.stringify({phase:'native-session-shutdown',pid:process.pid,monotonic_ns:process.hrtime.bigint().toString(),at:new Date().toISOString()})+'\\n'));};\n", { mode: 0o600 });
      const args = ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates',
        '--session-dir', sessions, '--tools', 'read,notion_list,notion_use', '-e', observer, '-e', config.candidate.extension,
        '-e', module, '--model', config.model, ...(session ? ['--session', session] : [])];
      await save(join(output, 'launch-' + processIndex + '.json'), { host, args, cwd, source, observerSha256: hash(await readFile(observer)), graphObserverSha256: hash(await readFile(module)), sourceHookSha256: hash(await readFile(hook)) });
      rpc = await startRpc({ host: config.pi.path, cwd, env, args, timeoutMs: 300000 });
      const state = await rpc.command('get_state'); await save(join(output, 'state-' + processIndex + '.json'), state);
    };
    try {
      await boot();
      const turns = [{ intent: item.intent, prompt: item.initial, mode: 'initial' }, ...item.followups];
      for (const [index, turn] of turns.entries()) {
        if (turn.mode === 'restart-and-resume-same-session') await boot();
        const before = (await rows(observationPath)).length, priorResponses = await collectIntentResponses(responsesPath);
        const beforeIds = new Set(priorResponses.map(row => row.requestId)), began = performance.now(), frameStart = rpc.frames.length;
        const receipt = { index, intent: turn.intent, prompt: turn.prompt, mode: turn.mode, status: 'running', processIndex };
        result.turns.push(receipt); manifest.submissions++;
        assert.ok(manifest.submissions <= executionScope.plannedBudget.maxSubmissions, 'Frozen maximum selected submissions exceeded');
        await save(join(evidence, 'manifest.json'), manifest); await save(join(output, 'result.json'), result);
        try {
          await rpc.prompt(turn.prompt.text);
          const observation = await rows(observationPath), turnObservation = observation.slice(before);
          assert.ok(turnObservation.some(event => event.phase === 'native-input' && event.textSha256 === turn.prompt.sha256), 'Actual native input must match the frozen prompt');
          const responses = await collectIntentResponses(responsesPath);
          Object.assign(receipt, assertIntentTurn({ observation, turnObservation, responses,
            newResponses: responses.filter(row => !beforeIds.has(row.requestId)), item, intent: turn.intent,
            oracle, catalogRecords: catalog.records, followup: index > 0 }));
          const state = await rpc.command('get_state'); session = state.sessionFile;
          assert.ok(session, 'An actual session file is required for continuation');
          receipt.session = session;
        } catch (error) {
          receipt.status = 'failed'; receipt.error = { code: error.code ?? 'INTENT_TURN_FAILED', message: error.message };
        }
        receipt.elapsedMs = performance.now() - began;
        receipt.providerUsage = rpc.frames.slice(frameStart).filter(frame => frame.type === 'message_end' && frame.message?.role === 'assistant').map(frame => frame.message.usage ?? null);
        const turnEvents = (await rows(observationPath)).slice(before);
        receipt.availabilityFailure = modelAvailabilityFailure(turnEvents.map(event => ({ ...event,
          phase: event.phase === 'provider-transport-response' ? 'response' : event.phase === 'assistant-final' ? 'assistant_final'
            : event.phase === 'tool-call' ? 'tool_call' : event.phase })));
        availabilityFailure ||= receipt.availabilityFailure;
        await save(join(output, 'turn-' + index + '.json'), receipt);
        if (receipt.status !== 'passed') break;
      }
    } catch (error) { result.error = { code: error.code ?? 'INTENT_HOST_FAILED', message: error.message }; }
    finally { try { await stop(); } catch (error) { result.error ??= { code: 'HOST_FINALITY_FAILED', message: error.message }; } }
    const observation = await rows(observationPath), responses = await collectIntentResponses(responsesPath), sourceLedger = await rows(ledger), hostLedger = await rows(owned);
    try {
      const selected = item.entryMode === 'explicit-root' ? oracle.preparations.B.map(row => ({ id: row.logicalId })) : [];
      const common = { observation, responses, sourceLedger, hostLedger, scope: oracle.target.scope,
        libraryId: oracle.target.logicalId.split(':')[1], catalogRecords: catalog.records, metadataOnly: item.intent === 'chat', selected };
      let attribution = graphSourceAttribution(common);
      await save(join(output, 'source-attribution-before-proof.json'), attribution);
      const supplementary = await collectSupplementaryRetainedProof({ config: { gate: item.id, retainedSourceProofRepo: config.retainedSourceProofRepo },
        evidence: output, trace: { httpAttempts: attribution.attempts }, responses, ownershipResponses: responses });
      result.retainedSourceObservation = supplementary.receipt;
      result.sourceAccounting = assertIntentSource({ ...common, retainedSourceProofs: supplementary.proof ? [supplementary.proof] : [] });
      assert.equal((await rows(traps.ledger)).length, 0, 'Legacy fallback was invoked');
      await inspectOwnedGraphProject(cwd);
      assert.ok(!result.error && result.turns.length === 1 + item.followups.length && result.turns.every(turn => turn.status === 'passed'));
      result.status = 'passed';
      if (item.intent === 'produce-and-exercise-artifact') {
        result.generatedPlan = await retainGeneratedPlan({ evidence: output, final: result.turns[0].final, prompt: item.initial, project });
        assert.equal(result.generatedPlan.artifactStatus, 'complete-skill-files-retained', 'Plan-only is not a generated verification Skill');
        result.files = await retainedFileInventory(output); await save(join(output, 'result.json'), result);
        const contents = await Promise.all(result.generatedPlan.files.map(file => readFile(join(output, file.evidencePath), 'utf8')));
        const candidates = [['npm', 'test'], ['npm', 'run', 'test'], ['node', '--test'], ['node', '--test', 'test/tickets.test.mjs']];
        const words = contents.flatMap(content => [...content.matchAll(/`([^`\n]+)`/g)].map(match => match[1]).concat(content.split('\n').map(line => line.trim().replace(/^\$ /, ''))));
        const command = candidates.find(command => words.includes(command.join(' ')));
        assert.ok(command, 'A permitted exact command must occur in a retained complete generated file');
        result.generatedProcedure = await exerciseGeneratedProcedure(await realpath(output), command);
        assert.equal(result.generatedProcedure.status, 'passed');
      }
    } catch (error) {
      result.status = 'failed'; result.error = { code: error.code ?? 'INTENT_EVIDENCE_FAILED', message: error.message };
    }
    result.semanticReview.status = result.status === 'passed' ? 'pending' : 'blocked_by_technical_failure';
    result.finishedAt = new Date().toISOString();
    result.files = [...new Set([...(await retainedFileInventory(output)), 'result.json'])];
    await save(join(output, 'result.json'), result);
    Object.assign(manifest.cases.at(-1), { status: result.status, semanticReview: result.semanticReview.status, turns: result.turns.length, error: result.error });
    await save(join(evidence, 'manifest.json'), manifest);
    if (availabilityFailure) { manifest.availabilityFailure = true; break; }
  }
  manifest.status = intentRunStatus(executionScope, manifest.cases);
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

export async function reviewIntentCases(configPath, evidence, reviewPath, selectedCase) {
  assert.ok(isAbsolute(evidence) && isAbsolute(reviewPath));
  const { config, semantic, executionScope, report: doctor } = await intentDoctor(configPath, selectedCase);
  const manifest = await json(join(evidence, 'manifest.json'));
  assert.equal(manifest.doctor.config.sha256, doctor.config.sha256);
  assert.deepEqual(manifest.executionScope ?? selectIntentCases(config), executionScope, 'Review must bind the original explicit selection');
  const results = await Promise.all(manifest.cases.map(item => json(join(item.evidence, 'result.json'))));
  const review = await json(reviewPath), verdict = validateIntentReview(review, manifest, results, semantic);
  await writeFile(join(evidence, 'manifest-before-review.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await save(join(evidence, 'semantic-review.json'), review);
  manifest.semanticReview = { ...verdict, path: reviewPath, sha256: hash(await readFile(reviewPath)) };
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
    for (const result of returned.filter(row => row.phase === 'metadata-result')) assert.ok(provider.some(row => row.toolResults.some(tool => tool.toolCallId === result.toolCallId && tool.sha256 === result.sha256 && tool.bytes === result.bytes && tool.exactToolOutputCopies === 1)), 'Metadata must reach the provider as one complete actual native tool output');
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
