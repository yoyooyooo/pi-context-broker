import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { resolveHost } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { consumptionCostExtensionSource, readConsumptionCostEvents } from './skill-consumption-cost.mjs';
import { providerTransportExtensionSource, readProviderTransport, providerApplicationCompletion } from './skill-consumption-provider.mjs';
import { sourceObserverPreloadSource, readSourceObservation } from './skill-consumption-source-observer.mjs';
import { observeGraphSdk } from './notion-skill-graph-model-evidence.mjs';
import { observeOwnedObjectReads } from './notion-sdk-pi.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = path => access(path).then(() => true, () => false);
const inside = (base, path) => { const rel = relative(base, path); return rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,120}$/u.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const { parse: parseYaml } = createRequire(new URL('../packages/context-broker/package.json', import.meta.url))('yaml');

export function candidatePlan(config) {
  assert.equal(config.version, 1);
  assert.equal(config.scope, 'project-scoped-candidate-precheck');
  assert.ok(Array.isArray(config.turns) && config.turns.length > 0);
  assert.equal(new Set(config.turns.map(turn => turn.id)).size, config.turns.length);
  assert.equal(new Set((config.expectedBodies ?? []).map(body => body.sha256)).size, (config.expectedBodies ?? []).length, 'Freeze each distinct body hash once');
  for (const turn of config.turns) {
    assert.ok(identifier(turn.id) && typeof turn.prompt === 'string' && turn.prompt.trim());
    assert.ok(turn.cancel === undefined || ['consume', 'read', 'read-resources'].includes(turn.cancel.operation));
    for (const body of turn.bodies ?? []) {
      assert.ok(digest(body.sha256) && Number.isSafeInteger(body.occurrences) && body.occurrences >= 0);
      assert.ok((config.expectedBodies ?? []).some(expected => expected.sha256 === body.sha256), 'Every body assertion needs frozen source bytes');
    }
    assert.ok(turn.proofs === undefined || Array.isArray(turn.proofs) && turn.proofs.every(proof => proof && typeof proof === 'object' && !Array.isArray(proof) && Object.keys(proof).length));
  }
  return {
    version: 1, scope: config.scope, status: 'prepared_not_executed',
    sourceId: config.sourceId, database: config.database, turns: config.turns.map(({ id, prompt, cancel }) => ({ id, promptSha256: hash(prompt), cancel: cancel ?? null })),
    projectPackages: 'The old exact local Broker source is filtered; the immutable installed candidate autoloads from the owned project.',
    preserved: ['normal HOME and agentDir', 'all other packages', 'local Skill roots, rules and catalogs', 'normal MCP, context files, provider configuration and tools'],
    changes: ['owned project settings', 'owned source config with reviewed Notion entry and empty cache', 'owned sessions and source state'],
    observers: ['existing cost and Undici transport', 'existing SDK diagnostics and owned object reads', 'passive tool receipt and final-answer events'],
    notClaimed: ['global daily package activation', 'AH718 inventory acceptance', 'Mini', 'Notion UI', 'semantic task success without separate review'],
  };
}

export function candidateProjectSettings(oldSource, candidateRoot) {
  assert.ok(isAbsolute(oldSource) && isAbsolute(candidateRoot) && oldSource !== candidateRoot);
  return { packages: [{ source: oldSource, extensions: [] }, candidateRoot] };
}

export function candidateSourceConfig(original, { sourceId, database, cacheDir, noNotion = false }) {
  assert.ok(identifier(sourceId) && /^[a-f0-9-]{32,36}$/iu.test(database) && isAbsolute(cacheDir));
  const config = structuredClone(original);
  const matches = (config.sources ?? []).filter(source => source.id === sourceId && source.type === 'notion');
  assert.equal(matches.length, 1, 'The reviewed existing Notion source must be unique');
  assert.ok((config.sources ?? []).filter(source => source.type === 'notion' && source.enabled !== false).every(source => source === matches[0]),
    'Another enabled Notion source needs an explicit reviewed scope');
  assert.equal(matches[0].command, undefined, 'The candidate must use its bundled SDK');
  assert.ok(matches[0].prefetch === undefined || matches[0].prefetch === false, 'Do not silently alter daily prefetch');
  assert.equal(matches[0].default_view_id, undefined, 'A daily View cannot be carried into a different test library');
  for (const key of ['skillRoots', 'extraSkillRoots', 'ruleRoots', 'discoveryCatalogs', 'extraDiscoveryCatalogs'])
    for (const path of config[key] ?? []) assert.ok(isAbsolute(path) || path.startsWith('~/'), 'Relative config paths need explicit scope review');
  Object.assign(matches[0], { database, cacheDir, ...(noNotion ? { enabled: false } : {}) });
  return config;
}

// Full receipt metadata and rendered hashes are retained for Broker-owned
// deliveries. No user settings, arbitrary local read output, headers or model
// request payloads are copied. Actual payload hashes and complete-body counts
// come from the existing cost observer and are paired with Undici below.
export function candidatePayloadBodies(value, expectedBodies) {
  const strings = [];
  const content = item => {
    if (typeof item === 'string') strings.push(item);
    else if (Array.isArray(item)) item.forEach(content);
    else if (item && typeof item === 'object') {
      if ((item.type === undefined || ['text', 'input_text', 'output_text'].includes(item.type)) && typeof item.text === 'string') strings.push(item.text);
      else if (item.type === 'tool_result') content(item.content);
      else if (Array.isArray(item.parts)) content(item.parts);
    }
  };
  const message = item => { content(item?.content); content(item?.parts); if (item?.type === 'function_call_output') content(item.output); };
  for (const key of ['messages', 'contents']) if (Array.isArray(value?.[key])) value[key].forEach(message);
  if (typeof value?.input === 'string') content(value.input); else if (Array.isArray(value?.input)) value.input.forEach(message);
  for (const key of ['system', 'system_instruction', 'systemInstruction', 'instructions', 'systemPrompt']) content(value?.[key]);
  return expectedBodies.map(body => {
    const xml = body.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const encodings = [...new Set([body.text, xml, JSON.stringify(body.text).slice(1, -1), JSON.stringify(xml).slice(1, -1)])];
    const spans = [];
    strings.forEach((string, contentIndex) => {
      const candidates = [];
      for (const encoded of encodings) {
        let start = string.indexOf(encoded);
        while (start >= 0) { candidates.push({ contentIndex, start, end: start + encoded.length }); start = string.indexOf(encoded, start + encoded.length); }
      }
      candidates.sort((left, right) => left.start - right.start || right.end - left.end);
      let end = -1;
      for (const span of candidates) if (span.start >= end) { spans.push(span); end = span.end; }
    });
    return { sha256: body.sha256, bytes: body.bytes, occurrences: spans.length, spans };
  });
}

export function observeCandidateTask(api, { fs, crypto, output, bodyFiles, inspectPayload }) {
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const expectedBodies = bodyFiles.map(file => {
    const bytes = fs.readFileSync(file.path);
    if (sha(bytes) !== file.sha256 || bytes.length !== file.bytes || bytes.length === 0) throw new Error('Frozen body bytes changed');
    return { sha256: file.sha256, bytes: file.bytes, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  });
  const fd = fs.openSync(output, 'wx', 0o600);
  let turn = 0, sequence = 0, previous = null, errors = 0, closed = false;
  const record = (phase, fields = {}) => {
    const row = { sequence: ++sequence, previousSha256: previous, pid: process.pid, monotonicNs: process.hrtime.bigint().toString(), turn, phase, ...fields };
    row.eventSha256 = sha(JSON.stringify(row)); previous = row.eventSha256;
    fs.writeSync(fd, JSON.stringify(row) + '\n');
  };
  const text = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
  const receipt = message => {
    if (!message || message.isError === true) return;
    const details = message.details;
    if (!details || typeof details !== 'object') return;
    const keys = ['contextBrokerPreparation', 'contextBrokerRead', 'contextBrokerResource'];
    const proofs = Object.fromEntries(keys.filter(key => details[key]).map(key => [key, details[key]]));
    if (message.role === 'custom' && ['context-broker', 'skill-prompt-message'].includes(message.customType)) proofs.custom = details;
    if (!Object.keys(proofs).length) return;
    const body = text(message.content);
    record('receipt', { toolName: message.toolName, toolCallId: message.toolCallId, customType: message.customType,
      content: { bytes: Buffer.byteLength(body), sha256: sha(body) }, proofs });
  };
  const on = (name, fn) => api.on(name, event => {
    if (closed) return;
    try { fn(event); } catch { errors++; record('observer_error', { event: name }); }
    // Always undefined: observation cannot block, transform or choose tools.
  });
  record('task_observer_start');
  on('input', () => { turn++; record('input'); });
  on('context_with_system', event => { for (const message of event.messages ?? []) receipt(message); });
  on('before_provider_request', event => {
    const payload = JSON.stringify(event.payload), toolNames = (event.payload?.tools ?? []).map(tool => tool.function?.name ?? tool.name).filter(name => typeof name === 'string');
    record('provider_payload', { sha256: sha(payload), bytes: Buffer.byteLength(payload), bodies: inspectPayload(event.payload, expectedBodies), toolNames,
      notionCatalogPresent: payload.includes('<ntn-skills-view-catalog>'), notionGuidancePresent: payload.includes('<ntn-skills-guidance>') });
  });
  on('tool_call', event => {
    const input = event.input ?? {};
    const selectors = Object.fromEntries(['path', 'paths', 'ref', 'refs', 'query', 'id', 'ids'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
    record('tool_call', { toolName: event.toolName, toolCallId: event.toolCallId, inputSha256: sha(JSON.stringify(input)), selectors,
      executionTool: ['bash', 'powershell', 'codemode', 'execute', 'eval'].includes(event.toolName),
      reviewedReadTool: ['read', 'grep', 'find', 'ls', 'notion_list', 'notion_use'].includes(event.toolName) });
  });
  on('tool_result', event => { record('tool_result', { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError === true }); receipt({ ...event, role: 'toolResult' }); });
  on('message_end', event => {
    const message = event.message;
    if (message?.role !== 'assistant' || !['stop', 'length', 'error', 'aborted'].includes(message.stopReason)) return;
    const value = text(message.content);
    record('assistant_final', { text: value, sha256: sha(value), bytes: Buffer.byteLength(value), stopReason: message.stopReason,
      success: ['stop', 'length'].includes(message.stopReason) && value.trim().length > 0 });
  });
  on('session_shutdown', () => { record('task_observer_end', { errors, complete: errors === 0 }); closed = true; fs.closeSync(fd); });
}

export function containsProof(value, expected) {
  if (!value || typeof value !== 'object') return false;
  const matches = !Array.isArray(value) && Object.entries(expected).every(([key, item]) => item && typeof item === 'object'
    ? Object.hasOwn(value, key) && containsProof(value[key], item) : Object.hasOwn(value, key) && value[key] === item);
  return matches || Object.values(value).some(child => child && typeof child === 'object' && containsProof(child, expected));
}

export function validateCandidateTurn(turn, { costs, transport, tasks }) {
  const requests = costs.filter(event => event.phase === 'provider_request');
  const sent = transport.filter(event => event.phase === 'request_sent');
  assert.ok(requests.length, 'No actual provider request was observed');
  for (const request of requests) {
    const matched = sent.filter(event => event.requestBodySha256 === request.payload.sha256 && event.requestBodyBytes === request.payload.bytes);
    assert.equal(matched.length, 1, 'Provider hook payload must match one actually sent HTTP body');
    assert.ok(transport.some(event => event.phase === 'request_start' && event.id === matched[0].id && event.category === 'model'), 'Sent body did not belong to the selected model');
    const ended = transport.find(event => event.phase === 'request_end' && event.id === matched[0].id);
    const message = costs.find(event => event.phase === 'message_end' && event.request === request.request)?.message;
    assert.ok(providerApplicationCompletion(ended, message), 'Actual provider transport has no completed application response');
    assert.ok(tasks.some(event => event.phase === 'provider_payload' && event.sha256 === request.payload.sha256 && event.bytes === request.payload.bytes), 'Task body observer did not see the exact sent payload');
  }
  const last = requests.at(-1);
  const actual = tasks.filter(event => event.phase === 'provider_payload' && event.sha256 === last.payload.sha256).at(-1);
  for (const expected of turn.bodies ?? []) {
    const counted = actual.bodies.filter(body => body.sha256 === expected.sha256);
    assert.equal(counted.length, 1, 'Frozen body was not independently observed'); assert.equal(counted[0].occurrences, expected.occurrences);
    if (expected.occurrences > 0 && expected.receiptRequired !== false) {
      const observed = last.payload.verifiedBodyOccurrences.filter(body => body.sha256 === expected.sha256);
      assert.equal(observed.length, 1, 'Missing exact receipt-verified full body'); assert.equal(observed[0].occurrences, expected.occurrences);
    }
    if (expected.occurrences === 0) for (const event of tasks.filter(event => event.phase === 'provider_payload'))
      assert.equal(event.bodies.find(body => body.sha256 === expected.sha256)?.occurrences, 0, 'Forbidden full body reached an earlier provider request');
  }
  for (const proof of turn.proofs ?? []) assert.ok(tasks.some(event => event.phase === 'receipt' && containsProof(event.proofs, proof)), 'Required source/snapshot/file proof missing');
  if (turn.requireUse) assert.ok(tasks.some(call => call.phase === 'tool_call' && call.toolName === 'notion_use' && typeof call.toolCallId === 'string'
    && tasks.some(event => event.phase === 'tool_result' && event.toolCallId === call.toolCallId && event.isError === false)
    && tasks.some(event => event.phase === 'receipt' && event.toolCallId === call.toolCallId && event.proofs.contextBrokerPreparation?.toolCallId === call.toolCallId
      && event.proofs.contextBrokerPreparation.purpose === 'use')), 'Natural application did not complete this turn\'s notion_use');
  assert.equal(tasks.filter(event => event.phase === 'tool_call' && event.executionTool).length, 0, 'The inspected Skill must not execute scripts or binaries');
  assert.equal(tasks.filter(event => event.phase === 'tool_call' && event.reviewedReadTool !== true).length, 0, 'An unreviewed tool cannot establish a read-only task');
  const final = tasks.filter(event => event.phase === 'assistant_final').at(-1);
  assert.ok(final?.success, 'This exact turn has no successful task answer');
  return { providerRequests: requests.length, lastPayloadSha256: last.payload.sha256, bodyOccurrences: actual.bodies, receiptVerifiedBodies: last.payload.verifiedBodyOccurrences,
    finalSha256: final.sha256, finalBytes: final.bytes, semanticReview: 'required', scriptExecutionToolCalls: 0 };
}

async function readRows(path) {
  if (!await exists(path)) return [];
  const text = await readFile(path, 'utf8');
  const end = text.lastIndexOf('\n');
  return end < 0 ? [] : text.slice(0, end).split('\n').filter(Boolean).map(JSON.parse);
}

async function waitUntil(check, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Requested observable boundary did not occur before deadline');
}

async function normalSnapshot(config, fileIdentity) {
  assert.ok(!process.env.PI_CODING_AGENT_DIR || await realpath(process.env.PI_CODING_AGENT_DIR) === await realpath(join(homedir(), '.pi/agent')));
  assert.ok(!process.env.CONTEXT_BROKER_CONFIG, 'Start from the normal source configuration');
  assert.ok(!process.env.NOTION_API_BASE_URL || process.env.NOTION_API_BASE_URL.replace(/\/$/u, '') === 'https://api.notion.com');
  const settingsPath = join(homedir(), '.pi/agent/settings.json'), settings = await json(settingsPath);
  const selected = settings.packages?.[config.packageIndex ?? 1];
  const oldSource = typeof selected === 'string' ? selected : selected?.source;
  assert.ok(isAbsolute(oldSource));
  assert.equal(await realpath(oldSource), await realpath(config.oldBrokerRoot), 'Daily Broker identity changed since review');
  const candidates = ['.yml', '.yaml', '.json'].map(ext => join(homedir(), '.pi/agent/context-broker/config' + ext));
  const sourcePath = (await Promise.all(candidates.map(async path => await exists(path) ? path : undefined))).find(Boolean);
  assert.ok(sourcePath);
  const source = parseYaml(await readFile(sourcePath, 'utf8'));
  const local = await fileIdentity(config.localSkill.path);
  assert.equal(local.sha256, config.localSkill.sha256, 'The real existing same-name local Skill changed');
  const context = [];
  for (const path of config.contextFiles ?? []) context.push(await fileIdentity(path));
  return { safe: { settings: await fileIdentity(settingsPath), source: await fileIdentity(sourcePath), oldSource,
    oldEntry: await fileIdentity(join(oldSource, 'src/index.ts')), oldRuntime: await fileIdentity(join(oldSource, 'dist/ntn-skills-runtime.json')),
    packages: settings.packages.length, otherPackagesSha256: hash(JSON.stringify(settings.packages.filter((_, index) => index !== (config.packageIndex ?? 1)))),
    local, context }, source, oldSource };
}

export async function runCandidate(config, { packageClosure, fileIdentity }) {
  const plan = candidatePlan(config);
  for (const key of ['brokerRoot', 'brokerArchive', 'brokerArchiveSha256', 'embeddedCliSha256', 'embeddedSdkSha256', 'cliRoot', 'cliArchive', 'cliArchiveSha256', 'cliEntrySha256', 'oldBrokerRoot', 'evidenceRoot'])
    assert.equal(typeof config[key], 'string', 'Missing final candidate artifact: ' + key);
  assert.equal(config.model, 'magpie/group/flash'); assert.equal(config.thinkingLevel, 'high');
  assert.ok(process.env.NOTION_API_TOKEN?.trim(), 'Owned source state requires the already inherited Notion credential');
  assert.ok(config.localSkill && isAbsolute(config.localSkill.path) && digest(config.localSkill.sha256) && identifier(config.localSkill.name));
  for (const body of config.expectedBodies ?? []) {
    assert.ok(isAbsolute(body.path) && digest(body.sha256) && Number.isSafeInteger(body.bytes) && body.bytes > 0);
    const actual = await fileIdentity(body.path); assert.equal(actual.sha256, body.sha256); assert.equal(actual.bytes, body.bytes);
  }
  assert.ok(isAbsolute(config.evidenceRoot) && !inside(root, config.evidenceRoot));
  const ownership = await fileIdentity(config.ownershipReceipt.path); assert.equal(ownership.sha256, config.ownershipReceipt.sha256);
  assert.ok(JSON.stringify(await json(ownership.path)).includes(config.database), 'Bind the owned fixture receipt to this exact database');
  const before = await normalSnapshot(config, fileIdentity);
  const broker = await packageClosure(config.brokerRoot, config.brokerArchive, config.brokerArchiveSha256);
  const cli = await packageClosure(config.cliRoot, config.cliArchive, config.cliArchiveSha256);
  const embedded = await fileIdentity(join(config.brokerRoot, 'dist/ntn-skills.mjs'));
  const sdk = await fileIdentity(join(config.brokerRoot, 'dist/ntn-skills-sdk.mjs'));
  const standalone = await fileIdentity(join(config.cliRoot, 'dist/ntn-skills.js'));
  const runtime = await json(join(config.brokerRoot, 'dist/ntn-skills-runtime.json'));
  assert.equal(embedded.sha256, config.embeddedCliSha256); assert.equal(sdk.sha256, config.embeddedSdkSha256);
  assert.equal(standalone.sha256, config.cliEntrySha256); assert.equal(runtime.cli_sha256, embedded.sha256); assert.equal(runtime.sdk_sha256, sdk.sha256);
  const artifactReceipt = await fileIdentity(config.artifactReceipt.path); assert.equal(artifactReceipt.sha256, config.artifactReceipt.sha256);
  const artifact = await json(artifactReceipt.path);
  assert.equal(artifact.status, 'passed'); assert.equal(artifact.host, 'pi'); assert.equal(artifact.buildInput.mode, 'explicit');
  assert.equal(artifact.buildInput.package, 'ntn-skills'); assert.equal(artifact.buildInput.cli.sha256, standalone.sha256);
  const cliManifestPath = join(config.cliRoot, 'package.json'), cliManifest = await json(cliManifestPath);
  const exportedSdk = cliManifest.exports?.['./sdk'], sdkImport = typeof exportedSdk === 'string' ? exportedSdk : exportedSdk?.import;
  assert.ok(typeof sdkImport === 'string' && sdkImport.startsWith('./'));
  const inputSdk = await fileIdentity(resolve(config.cliRoot, sdkImport)); assert.ok(inside(await realpath(config.cliRoot), inputSdk.realpath));
  assert.equal(artifact.buildInput.manifest.sha256, (await fileIdentity(cliManifestPath)).sha256);
  assert.equal(artifact.buildInput.sdk.sha256, inputSdk.sha256); assert.equal(artifact.runtime.cli.sha256, embedded.sha256); assert.equal(artifact.runtime.sdk.sha256, sdk.sha256);
  assert.equal(artifact.package.archive.sha256, broker.archive.sha256);
  const harness = await Promise.all([
    'scripts/verify-pi-daily-installation.mjs', 'scripts/verify-pi-daily-candidate.mjs', 'scripts/skill-consumption-cost.mjs',
    'scripts/skill-consumption-provider.mjs', 'scripts/skill-consumption-source-observer.mjs', 'scripts/notion-skill-graph-model-evidence.mjs',
    'scripts/notion-sdk-pi.mjs', 'scripts/notion-default-context.mjs',
    'packages/context-broker/scripts/context-broker-rpc-harness.mjs', 'packages/context-broker/scripts/context-broker-e2e-fixture.mjs',
  ].map(path => fileIdentity(join(root, path))));
  await mkdir(config.evidenceRoot, { recursive: true, mode: 0o700 });
  const evidence = await mkdtemp(join(config.evidenceRoot, 'daily-candidate-'));
  let previous;
  if (config.resumeFrom) {
    const receipt = await fileIdentity(config.resumeFrom.path); assert.equal(receipt.sha256, config.resumeFrom.sha256);
    assert.ok(inside(await realpath(config.evidenceRoot), receipt.realpath), 'Only an owned prior candidate run may be resumed');
    previous = await json(receipt.path);
    assert.equal(previous.scope, config.scope); assert.equal(previous.status, 'passed'); assert.equal(previous.plan.database, config.database);
    assert.equal(previous.artifacts.embedded.sha256, embedded.sha256); assert.equal(previous.artifacts.sdk.sha256, sdk.sha256);
    assert.ok(inside(previous.evidence, previous.session.artifact.path));
    const session = await fileIdentity(previous.session.artifact.path); assert.equal(session.sha256, previous.session.artifact.sha256);
  }
  const cwd = previous?.launch.cwd ?? join(evidence, 'workspace'), control = join(evidence, 'observation'), sessions = join(evidence, 'sessions'), responses = join(evidence, 'sdk-responses');
  for (const path of [cwd, join(cwd, '.pi'), control, sessions, responses]) await mkdir(path, { recursive: true, mode: 0o700 });
  const sourcePath = join(control, 'source.json'), sourceCache = join(cwd, 'broker-cache');
  const source = candidateSourceConfig(before.source, { sourceId: config.sourceId, database: config.database, cacheDir: sourceCache, noNotion: config.noNotion === true });
  const projectSettings = candidateProjectSettings(before.oldSource, config.brokerRoot);
  if (previous) assert.deepEqual(await json(join(cwd, '.pi/settings.json')), projectSettings, 'The original owned project package mapping changed');
  else await save(join(cwd, '.pi/settings.json'), projectSettings);
  await save(sourcePath, source); await save(join(evidence, 'config.json'), config); await save(join(evidence, 'broker-files.json'), broker); await save(join(evidence, 'cli-files.json'), cli);
  const clockId = randomUUID(), host = await resolveHost('pi');
  assert.ok(host.identity.includes('/@earendil-works/pi-coding-agent/'));
  const costs = join(control, 'cost.jsonl'), transport = join(control, 'transport.jsonl'), tasks = join(control, 'tasks.jsonl'), sourceLedger = join(control, 'source.jsonl'), sdkLedger = join(control, 'sdk.jsonl'), objects = join(control, 'objects.jsonl');
  const costExtension = join(control, 'cost.mjs'), transportExtension = join(control, 'transport.mjs'), taskExtension = join(control, 'tasks.mjs'), sourcePreload = join(control, 'source.mjs'), sdkPreload = join(control, 'sdk.mjs');
  await writeFile(costExtension, consumptionCostExtensionSource({ output: costs, checkoutRoot: root, runId: clockId, sampleId: 'daily-candidate', clockId }), { mode: 0o600, flag: 'wx' });
  await writeFile(transportExtension, providerTransportExtensionSource({ output: transport, checkoutRoot: root, clockId }), { mode: 0o600, flag: 'wx' });
  await writeFile(taskExtension, "import fs from 'node:fs'; import crypto from 'node:crypto';\nconst inspectPayload=" + candidatePayloadBodies.toString() + ';\nexport default api => (' + observeCandidateTask.toString() + ')(api,{fs,crypto,inspectPayload,output:' + JSON.stringify(tasks) + ',bodyFiles:' + JSON.stringify(config.expectedBodies ?? []) + '});\n', { mode: 0o600, flag: 'wx' });
  await writeFile(sourcePreload, sourceObserverPreloadSource({ output: sourceLedger, checkoutRoot: root, clockId, cliPath: embedded.realpath, ownerParentPid: process.pid, ownerEntry: host.path }), { mode: 0o600, flag: 'wx' });
  const state = join(cwd, 'ntn/state');
  await writeFile(sdkPreload, "import fs from 'node:fs'; import fsPromises from 'node:fs/promises'; import {channel} from 'node:diagnostics_channel'; import {createHash} from 'node:crypto'; import {syncBuiltinESMExports} from 'node:module'; import {isMainThread} from 'node:worker_threads';\n"
    + 'const hash=value=>createHash("sha256").update(value).digest("hex");\n' + safeRequestMetrics.toString() + '\n'
    + 'if(isMainThread&&process.ppid===' + process.pid + '){const sdk=(' + observeGraphSdk.toString() + ')({channel,fs,safeMetrics:safeRequestMetrics,paths:' + JSON.stringify({ ledger: sdkLedger, responses, outputRoot: sourceCache }) + '});\n'
    + 'const objects=(' + observeOwnedObjectReads.toString() + ')({fs,fsPromises,hash,objects:' + JSON.stringify(join(state, 'objects'))
    + ',record:row=>fs.appendFileSync(' + JSON.stringify(objects) + ',JSON.stringify({monotonicNs:process.hrtime.bigint().toString(),...row})+"\\n",{mode:0o600})});syncBuiltinESMExports();let done=false;const finish=()=>{if(!done){done=true;objects.finish();sdk.close();}};process.once("beforeExit",finish);process.once("exit",finish);}\n', { mode: 0o600, flag: 'wx' });
  const env = { ...process.env, CONTEXT_BROKER_CONFIG: sourcePath, NTN_SKILLS_HOME: state, NTN_SKILLS_CONFIG_HOME: join(cwd, 'ntn/config'), NTN_SKILLS_CACHE_HOME: join(cwd, 'ntn/cache'), NTN_SKILLS_DATA_HOME: join(cwd, 'ntn/data'), NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000',
    BROKER_E2E_PROCESS_LEDGER: join(evidence, 'owned-processes.jsonl'), NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + JSON.stringify(sourcePreload), '--import=' + JSON.stringify(sdkPreload)].filter(Boolean).join(' ') };
  const args = ['--approve', '--session-dir', sessions, '--model', config.model, '--thinking', config.thinkingLevel, '-e', costExtension, '-e', transportExtension, '-e', taskExtension];
  let resumedSession;
  if (previous) {
    resumedSession = join(sessions, basename(previous.session.artifact.path));
    await writeFile(resumedSession, await readFile(previous.session.artifact.path), { flag: 'wx', mode: 0o600 });
    args.push('--session', resumedSession);
  }
  const result = { version: 1, scope: config.scope, status: 'running', evidence, plan, ownership, host, hostArtifact: await fileIdentity(host.identity), harness, before: before.safe,
    artifacts: { brokerArchive: broker.archive, brokerFilesSha256: broker.sha256, cliArchive: cli.archive, embedded, sdk, standalone, inputSdk, runtime, artifactReceipt, buildInput: artifact.buildInput },
    launch: { cwd, args, normalHome: true, normalAgentDir: true, targetExtensionArgument: false, sourceCommandConfigured: false, normalTools: true, normalMcpAndContext: true, sourceStateStartsEmpty: !previous,
      resume: previous ? { source: previous.session.artifact, copiedOwnedSessionOnly: true, originalSessionPreserved: true, sourceCache: 'original-owned-warm-state' } : null },
    turns: config.turns.map(turn => ({ id: turn.id, status: 'not_run' })), semanticReview: 'required', globalDailyActivation: 'not_tested', modifications: { globalSettings: 0, dailySourceConfig: 0, credentialCopies: 0 } };
  await save(join(evidence, 'started.json'), result);
  let rpc;
  try {
    rpc = await startRpc({ host: 'pi', cwd, env, args, timeoutMs: config.rpcTimeoutMs ?? 300000 });
    const initial = await rpc.command('get_state');
    assert.equal(initial.model?.provider, 'magpie'); assert.equal(initial.model?.id, 'group/flash'); assert.equal(initial.thinkingLevel, 'high');
    result.session = { sessionId: initial.sessionId, sessionFile: initial.sessionFile };
    assert.ok(inside(sessions, resolve(initial.sessionFile)));
    const commands = (await rpc.command('get_commands')).commands;
    const registrations = commands.filter(command => command.name === 'context-broker');
    assert.equal(registrations.length, 1); const actualEntry = await fileIdentity(registrations[0].sourceInfo.path);
    assert.ok(inside(await realpath(config.brokerRoot), actualEntry.realpath));
    result.autoload = { source: registrations[0].source, sourceInfo: registrations[0].sourceInfo, actualEntry };
    result.localCommand = [];
    for (const command of commands.filter(command => command.source === 'skill' && command.name === 'skill:' + config.localSkill.name)) {
      if (!command.sourceInfo?.path) continue;
      if (await realpath(command.sourceInfo.path) === before.safe.local.realpath)
        result.localCommand.push({ name: command.name, source: command.source, sourceInfo: command.sourceInfo });
    }
    assert.ok(result.localCommand.length > 0, 'The real existing local Skill was not discovered by normal Pi');
    await save(join(evidence, 'commands.json'), commands.map(command => ({ name: command.name, source: command.source, sourceInfo: command.sourceInfo })));
    for (const [file, phase] of [[costs, 'observer_start'], [transport, 'transport_start'], [tasks, 'task_observer_start'], [sourceLedger, 'source_observer_start'], [sdkLedger, 'sdk-observer-start']])
      assert.equal((await readRows(file))[0]?.phase, phase, 'A required observer did not start; do not spend a model request without it');
    assert.equal((await readRows(objects))[0]?.kind, 'object_observer_start');
    for (let index = 0; index < config.turns.length; index++) {
      const turn = config.turns[index], startedNs = process.hrtime.bigint().toString();
      const receipt = result.turns[index]; receipt.status = 'running'; receipt.startedNs = startedNs;
      receipt.forbiddenObjectsBefore = await Promise.all((turn.forbiddenObjectSha256s ?? []).map(async sha256 => {
        assert.ok(digest(sha256)); return { sha256, present: await exists(join(state, 'objects', sha256)) };
      }));
      let failure;
      try {
        if (turn.cancel) {
          const pending = rpc.prompt(turn.prompt).then(() => ({ status: 'completed' }), error => ({ status: 'rejected', message: error.message }));
          const boundary = await waitUntil(async () => {
            const rows = await readRows(sourceLedger);
            return rows.find(event => event.phase === 'started' && event.kind === 'sdk' && event.operation === turn.cancel.operation && BigInt(event.monotonicNs) >= BigInt(startedNs)
              && !rows.some(end => end.phase === 'completed' && end.requestId === event.requestId));
          }, turn.cancel.timeoutMs ?? 30000);
          receipt.cancelBoundary = boundary; receipt.abortNs = process.hrtime.bigint().toString(); receipt.abort = await rpc.command('abort'); receipt.promptOutcome = await pending;
          await waitUntil(async () => !(await rpc.command('get_state')).isStreaming, 30000);
          receipt.cancelCompletion = await waitUntil(async () => (await readRows(sourceLedger)).find(event => event.phase === 'completed' && event.requestId === boundary.requestId), 30000);
          receipt.cancellation = 'requested-at-observed-sdk-start';
        } else await rpc.prompt(turn.prompt);
      } catch (error) { failure = error; }
      const endedNs = process.hrtime.bigint().toString(); receipt.endedNs = endedNs;
      receipt.forbiddenObjectsAfter = await Promise.all(receipt.forbiddenObjectsBefore.map(async item => ({ sha256: item.sha256, present: await exists(join(state, 'objects', item.sha256)) })));
      const slice = rows => rows.filter(row => BigInt(row.monotonicNs ?? row.monotonic_ns ?? '0') >= BigInt(startedNs) && BigInt(row.monotonicNs ?? row.monotonic_ns ?? '0') <= BigInt(endedNs));
      const observed = { costs: slice(await readRows(costs)), transport: slice(await readRows(transport)), tasks: slice(await readRows(tasks)), source: slice(await readRows(sourceLedger)), objects: slice(await readRows(objects)) };
      await save(join(evidence, 'turn-' + turn.id + '.json'), { turn, ...receipt, observed, failure: failure ? { message: failure.message } : null });
      if (failure) throw failure;
      if (!turn.cancel) receipt.assertions = validateCandidateTurn(turn, observed);
      else {
        const requests = observed.costs.filter(event => event.phase === 'provider_request');
        assert.equal(requests.filter(event => BigInt(event.monotonicNs) <= BigInt(receipt.abortNs)).length, turn.cancel.providerRequestsBeforeAbort ?? 0, 'Cancellation occurred after an unexpected provider dispatch');
        assert.equal(requests.filter(event => BigInt(event.monotonicNs) > BigInt(receipt.abortNs)).length, 0, 'Cancelled input dispatched a new provider request');
        assert.equal(receipt.cancelCompletion.status, 'cancelled', 'The exact observed SDK operation did not finish cancelled');
      }
      assert.equal(observed.tasks.filter(event => event.phase === 'tool_call' && event.executionTool).length, 0);
      assert.equal(observed.tasks.filter(event => event.phase === 'tool_call' && event.reviewedReadTool !== true).length, 0);
      if (turn.forbiddenObjectSha256s?.length) {
        assert.ok(observed.objects.some(event => event.kind === 'object_read' && event.event === 'end' && event.api === 'node:fs.readFile' && event.code === null && event.bytes > 0), 'Missing positive control for selected source object reads');
        for (const sha256 of turn.forbiddenObjectSha256s) assert.equal(observed.objects.filter(event => event.kind === 'object_read' && event.object_sha256 === sha256).length, 0, 'Unselected source object was read');
        for (const item of receipt.forbiddenObjectsBefore) if (!item.present)
          assert.equal(receipt.forbiddenObjectsAfter.find(after => after.sha256 === item.sha256).present, false, 'An unselected source object was materialized');
      }
      receipt.status = 'passed';
      await save(join(evidence, 'turn-' + turn.id + '-verdict.json'), receipt);
    }
    await rpc.closeInput();
    result.cost = await readConsumptionCostEvents(costs); result.transport = await readProviderTransport(transport); result.source = await readSourceObservation(sourceLedger);
    assert.equal(result.transport.at(-1)?.complete, true);
    assert.equal(result.source.complete, true); assert.deepEqual(result.source.errors, []);
    assert.ok(result.cost.events.at(-1)?.phase === 'observer_end' && result.cost.events.at(-1).complete);
    assert.ok((await readRows(tasks)).at(-1)?.complete);
    const objectRows = await readRows(objects), objectEnd = objectRows.at(-1);
    assert.equal(objectEnd?.kind, 'object_observer_end'); assert.equal(objectEnd.pending_reads, 0); assert.equal(objectEnd.errors, 0);
    if (config.noNotion) {
      assert.equal(result.source.events.filter(event => event.phase === 'started').length, 0, 'Disabled Notion source invoked the source transport');
      assert.equal(objectEnd.reads, 0);
      for (const payload of (await readRows(tasks)).filter(event => event.phase === 'provider_payload')) {
        assert.ok(!payload.notionCatalogPresent && !payload.notionGuidancePresent, 'Disabled source still exposed Notion context');
        assert.ok(payload.toolNames.every(name => !name.startsWith('notion_')), 'Disabled source still exposed Notion tools');
      }
    }
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = { code: error.code ?? 'CANDIDATE_PRECHECK_FAILED', message: error.message };
    const active = result.turns.find(turn => turn.status === 'running');
    if (active) { active.status = 'failed'; active.error = result.error; await save(join(evidence, 'turn-' + active.id + '-verdict.json'), active); }
  } finally {
    if (rpc && !rpc.lifecycle.some(event => event.event === 'close')) await rpc.stop().catch(error => { result.shutdownError = error.message; });
    if (rpc) { result.lifecycle = rpc.lifecycle; await save(join(evidence, 'rpc-lifecycle.json'), rpc.lifecycle); }
    if (result.session?.sessionFile && await exists(result.session.sessionFile)) result.session.artifact = await fileIdentity(result.session.sessionFile);
    if (previous) result.resumedOriginalUnchanged = (await fileIdentity(previous.session.artifact.path)).sha256 === previous.session.artifact.sha256;
    const after = await normalSnapshot(config, fileIdentity).catch(error => ({ safe: { failure: error.message } }));
    result.after = after.safe; result.normalConfigurationUnchanged = JSON.stringify(before.safe) === JSON.stringify(after.safe);
    result.candidateFilesUnchanged = (await Promise.all(broker.files.map(async file => hash(await readFile(join(config.brokerRoot, file.path))) === file.sha256))).every(Boolean);
    result.cliFilesUnchanged = (await Promise.all(cli.files.map(async file => hash(await readFile(join(config.cliRoot, file.path))) === file.sha256))).every(Boolean);
    result.harnessUnchanged = (await Promise.all(harness.map(async file => hash(await readFile(file.path)) === file.sha256))).every(Boolean);
    if (!result.normalConfigurationUnchanged || !result.candidateFilesUnchanged || !result.cliFilesUnchanged || !result.harnessUnchanged || result.resumedOriginalUnchanged === false) result.status = 'failed';
    await save(join(evidence, 'result.json'), result);
  }
  return { status: result.status, scope: result.scope, evidence, error: result.error, turns: result.turns, semanticReview: result.semanticReview };
}
