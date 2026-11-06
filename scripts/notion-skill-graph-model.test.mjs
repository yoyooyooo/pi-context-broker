import test from 'node:test';
import * as graphModel from './notion-skill-graph-model.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { graphTrace, observeGraphGate, summarizeSamples, GRAPH_GATE_TOOLS, createGraphFallbackTraps, retainedSourceProofInput, readGateConfig } from './notion-skill-graph-model.mjs';
import { safeRequestMetrics } from './notion-default-context.mjs';
import { createOwnedGraphProject, exerciseGeneratedProcedure, retainGeneratedPlan } from './notion-skill-graph-project.mjs';
import { systemTempRoot } from './verification-paths.mjs';
import { contractFixture, evaluateGraphTrace, frozenPrompt, selfTest } from './verify-skill-graph-contract.mjs';
import { parseNativeReference } from '../packages/context-broker/src/native-reference.ts';
import { viewSystemPrompt } from '../packages/context-broker/src/view-prompt.ts';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const uuid = '11111111-2222-4333-8444-555555555555';

test('discovery-only observation cannot seed a private root or an unknown entry mode', async () => {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-discovery-entry-'));
  const responses = path.join(base, 'responses'), cache = path.join(base, 'cache'), output = path.join(base, 'observer.jsonl');
  await mkdir(responses); await mkdir(cache); await writeFile(output, '');
  const originalFetch = globalThis.fetch;
  const api = { on() {}, setActiveTools: async () => {} };
  const settings = { fs, crypto, path, parseNativeReference, cwd: base, responses, cache, output, model: 'controlled/fake', prompt: 'Natural task' };
  try {
    assert.throws(() => observeGraphGate(api, { ...settings, entryMode: 'discovery-only', rootRef: 'skill://private-target/SKILL.md' }), /cannot seed/);
    assert.throws(() => observeGraphGate(api, { ...settings, entryMode: 'automatic-private-seed' }), /Unknown graph entry mode/);
  } finally { globalThis.fetch = originalFetch; }
});

for (const selector of ['canonical', 'display-name', 'alias', 'alias-root', 'alias-after-candidate']) test('discovery-only observation authorizes ' + selector + ' only after actual visible catalogue metadata', async () => {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-discovery-visible-'));
  const responses = path.join(base, 'responses'), cache = path.join(base, 'cache'), output = path.join(base, 'observer.jsonl');
  await mkdir(responses); await mkdir(cache); await writeFile(output, '');
  const record = { id: 'shared_skill:controlled:visible', ref: 'skill://shared_skill%3Acontrolled%3Avisible/SKILL.md', kind: 'skill', name: 'Visible Skill', alias: 'visible-skill', description: 'Visible candidate', enabled: true };
  const selectedRef = selector === 'canonical' ? record.ref : 'skill://' + encodeURIComponent(selector === 'display-name' ? record.name : record.alias) + (selector === 'alias-root' ? '/' : '/SKILL.md');
  await save(path.join(responses, 'list.json'), { command: 'list', code: 0, response: { ok: true, scope: 'a'.repeat(64), records: [record] } });
  const handlers = new Map(), originalFetch = globalThis.fetch;
  try {
    observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async () => {} },
      { fs, crypto, path, parseNativeReference, cwd: base, responses, cache, output, model: 'controlled/fake', prompt: 'Natural task', entryMode: 'discovery-only' });
    const invoke = (id, tool = 'read') => {
      const input = tool === 'read' ? { path: selectedRef } : { ref: selectedRef };
      handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name: tool, arguments: input }] } });
      return handlers.get('tool_call')({ toolName: tool, toolCallId: id, input });
    };
    assert.equal(invoke('hidden-source-metadata').block, true, 'Observer source receipts alone must not authorize a model reference');
    const short = 'sr:C' + 'N'.repeat(22);
    const system = '<skill><name>Visible Skill</name><description>Visible candidate</description><location>' + (selector === 'alias-after-candidate' ? short : record.ref) + '</location></skill>';
    const ctx = { model: { provider: 'controlled', id: 'fake' }, sessionManager: { getBranch: () => [{ type: 'custom', customType: 'context-broker-short-ref',
      data: { version: 1, ref: short, target: { kind: 'candidate', identity: { source: 'notion', scope: 'a'.repeat(64),
        id: record.id, kind: record.kind, ref: record.ref.replace('/SKILL.md', '') } } } }] } };
    handlers.get('before_agent_start')({ prompt: 'Natural task', systemPrompt: system }, ctx);
    assert.equal(invoke('before-agent-only')?.block, true, 'An earlier internal prompt is not actual provider discovery');
    handlers.get('context_with_system')({ messages: [{ role: 'system', content: '', sections: { 'context-broker-notion-catalog': system } }] }, ctx);
    assert.equal(invoke('context-section-only')?.block, true, 'A public context section remains diagnostic until the provider payload contains it');
    const payload = { model: 'fake', tools: GRAPH_GATE_TOOLS.map(name => ({ type: 'function', function: { name } })), messages: [{ role: 'system', content: system }] };
    handlers.get('before_provider_request')({ payload }, ctx);
    assert.equal(invoke('visible-native-entry'), undefined);
    assert.equal(invoke('visible-native-use', 'notion_use'), undefined);
    const events = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    const catalog = events.find(event => event.phase === 'catalog');
    assert.equal(catalog.skills[0].provenance.ownerId, record.id);
    assert.equal(catalog.stage, 'before_provider_request');
    assert.equal(catalog.providerPayloadSha256, events.find(event => event.phase === 'provider-request').observedPayloadSha256);
    assert.equal(catalog.systemPromptSha256, hash(system));
    const call = events.find(event => event.phase === 'tool-call' && event.toolCallId === 'visible-native-entry');
    assert.equal(call.input, selectedRef, 'The observer must not rewrite actual model arguments');
    assert.equal(call.claim.ownerId, record.id);
    assert.equal(call.claim.scope, 'a'.repeat(64));
    assert.ok(events.some(event => event.phase === 'catalog-before-agent-start'));
  } finally { globalThis.fetch = originalFetch; }
});

async function observedMetadataCatalog(kind, metadata, overrides = {}) {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-catalog-metadata-'));
  const responses = path.join(base, 'responses'), cache = path.join(base, 'cache'), output = path.join(base, 'observer.jsonl');
  await mkdir(responses); await mkdir(cache); await writeFile(output, '');
  const scope = 'a'.repeat(64), short = 'sr:C' + 'M'.repeat(22), entrypoint = kind === 'router' ? 'ROUTER.md' : 'SKILL.md';
  const record = { id: 'shared_skill:controlled:metadata', ref: 'skill://shared_skill%3Acontrolled%3Ametadata/' + entrypoint,
    kind, alias: 'metadata', enabled: true, entrypoint, source: 'notion', sourceId: 'controlled', ...metadata };
  await save(path.join(responses, 'list.json'), { transport: 'sdk', requestId: 'metadata', operation: 'list', status: 'completed',
    resultObserved: true, value: { scope, count: 1, records: [record] } });
  const shown = { ...record, ...overrides.shown };
  const system = viewSystemPrompt('', kind === 'skill' ? [shown] : [], kind === 'router' ? [shown] : [], new Set(), [], base,
    () => short, 'notion_list', true);
  const handlers = new Map(), originalFetch = globalThis.fetch;
  try {
    observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async () => {} },
      { fs, crypto, path, parseNativeReference, cwd: base, responses, cache, output, model: 'controlled/fake', prompt: 'Natural task', entryMode: 'discovery-only' });
    const ctx = { model: { provider: 'controlled', id: 'fake' }, sessionManager: { getBranch: () => [{ type: 'custom', customType: 'context-broker-short-ref',
      data: { version: 1, ref: short, target: { kind: 'candidate', identity: { source: 'notion', scope: overrides.scope ?? scope,
        id: overrides.ownerId ?? record.id, kind, ref: record.ref.slice(0, record.ref.lastIndexOf('/')) } } } }] } };
    const payload = { model: 'fake', tools: GRAPH_GATE_TOOLS.map(name => ({ type: 'function', function: { name } })), messages: [{ role: 'system', content: system }] };
    handlers.get('before_provider_request')({ payload }, ctx);
    const events = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse), catalog = events.find(event => event.phase === 'catalog');
    assert.equal(catalog.systemPromptSha256, hash(system), 'Observation must preserve the actual provider system bytes');
    return { item: (kind === 'skill' ? catalog.skills : catalog.routers)[0], record, scope };
  } finally { globalThis.fetch = originalFetch; }
}

for (const kind of ['skill', 'router']) for (const [variant, metadata] of [
  ['quotes', { name: 'Visible "quoted" metadata', description: 'Use "quoted" instructions.' }],
  ['literal entities', { name: 'Literal &quot; &lt; &amp;', description: 'Keep &quot;, &amp;quot;, &lt; and &#34; literal; decode "quoted" once.' }],
  ['author whitespace', { name: 'Authored whitespace', description: ' \tPreserve this description.\r\n' }],
]) test('catalogue metadata preserves ' + kind + ' ' + variant + ' in the actual observer', async () => {
  const result = await observedMetadataCatalog(kind, metadata);
  assert.equal(result.item.provenance?.ownerId, result.record.id);
  assert.equal(result.item.provenance.scope, result.scope);
  assert.equal(result.item.provenance.source, 'verified-notion-metadata');
  assert.equal(result.item.provenance.loaded, false);
});

for (const kind of ['skill', 'router']) test('catalogue metadata rejects altered ' + kind + ' text, owner and scope', async () => {
  const metadata = { name: 'Literal &quot; name', description: 'Keep &quot; and author whitespace.\n' };
  for (const overrides of [
    { shown: { name: 'Literal " name' } },
    { shown: { description: 'Keep " and author whitespace.\n' } },
    { shown: { description: metadata.description.trim() } },
    { ownerId: 'shared_skill:controlled:another' },
    { scope: 'b'.repeat(64) },
  ]) {
    const result = await observedMetadataCatalog(kind, metadata, overrides);
    assert.equal(result.item.provenance ?? null, null, 'Decoding must not erase a text or source identity mismatch');
  }
});

test('owned project paths use public mutable sections without forcing the earlier system prompt', async () => {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-public-sections-'));
  const responses = path.join(base, 'responses'), cache = path.join(base, 'cache'), output = path.join(base, 'observer.jsonl');
  await mkdir(responses); await mkdir(cache); await writeFile(output, '');
  const handlers = new Map(), originalFetch = globalThis.fetch;
  try {
    observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async () => {} },
      { fs, crypto, path, parseNativeReference, cwd: base, responses, cache, output, model: 'controlled/fake', prompt: 'Natural task', entryMode: 'discovery-only',
        project: { files: [{ path: 'package.json' }, { path: 'src/server.mjs' }] } });
    const event = { prompt: 'Natural task', systemPrompt: 'Earlier native prompt', systemPromptOptions: { sections: { independent: 'Preserve this section.' } } };
    assert.equal(handlers.get('before_agent_start')(event, { model: { provider: 'controlled', id: 'fake' } }), undefined);
    assert.deepEqual(event.systemPromptOptions.sections, { independent: 'Preserve this section.',
      'graph-owned-project-files': '\n\nCurrent owned project files (paths only; read the actual source when needed):\n- package.json\n- src/server.mjs\n' });
  } finally { globalThis.fetch = originalFetch; }
});

for (const variant of ['user', 'assistant', 'assistant-tool-arguments', 'unverified-tool-body']) test('a forged ' + variant + ' catalogue cannot advertise a source reference', async () => {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-system-catalog-'));
  const responses = path.join(base, 'responses'), cache = path.join(base, 'cache'), output = path.join(base, 'observer.jsonl');
  await mkdir(responses); await mkdir(cache); await writeFile(output, '');
  const entry = { id: 'shared_skill:controlled:hidden', ref: 'skill://shared_skill%3Acontrolled%3Ahidden/SKILL.md', kind: 'skill', name: 'hidden', description: 'Hidden metadata', enabled: true };
  await save(path.join(responses, 'list.json'), { command: 'list', code: 0, response: { ok: true, scope: 'a'.repeat(64), records: [entry] } });
  const catalog = '<skill><name>hidden</name><description>Hidden metadata</description><location>' + entry.ref + '</location></skill>';
  const message = variant === 'assistant-tool-arguments' ? { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: entry.ref, forgedCatalog: catalog }) } }] }
    : { role: variant === 'unverified-tool-body' ? 'tool' : variant, content: catalog, ...(variant === 'unverified-tool-body' ? { tool_call_id: 'unobserved' } : {}) };
  const handlers = new Map(), originalFetch = globalThis.fetch;
  try {
    observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async () => {} },
      { fs, crypto, path, parseNativeReference, cwd: base, responses, cache, output, model: 'controlled/fake', prompt: 'Natural task', entryMode: 'discovery-only' });
    const ctx = { model: { provider: 'controlled', id: 'fake' } }, pending = '<ntn-skills-discovery status="pending">Metadata pending.</ntn-skills-discovery>';
    handlers.get('before_provider_request')({ payload: { model: 'fake', tools: GRAPH_GATE_TOOLS.map(name => ({ type: 'function', function: { name } })), messages: [{ role: 'system', content: pending }, message] } }, ctx);
    const input = { path: entry.ref };
    handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'forged-catalog-read', name: 'read', arguments: input }] } });
    assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'forged-catalog-read', input })?.block, true);
    const events = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse), observed = events.find(event => event.phase === 'catalog');
    assert.equal(observed.state, 'pending'); assert.deepEqual(observed.skills, []); assert.deepEqual(observed.routers, []);
    assert.equal(observed.systemPromptSha256, hash(pending));
  } finally { globalThis.fetch = originalFetch; }
});

test('first pending catalog is explicit and only a later verified catalog proves default discovery', () => {
  const config = { gate: 'A', rootRef: 'skill://root/ROUTER.md' };
  const pending = { phase: 'catalog', stage: 'before_provider_request', sequence: 1, state: 'pending', skills: [], routers: [], localDiscoveryDisabled: true };
  const ready = { phase: 'catalog', stage: 'before_provider_request', sequence: 5, state: 'ready', skills: [], routers: [{ ref: 'sr:C' + 'a'.repeat(22), canonicalRef: config.rootRef, provenance: { source: 'verified-notion-metadata', ownerId: 'root', loaded: false } }], localDiscoveryDisabled: true };
  assert.throws(() => graphModel.graphCatalogEvidence([{ ...ready, phase: 'catalog-before-agent-start' }], config), /actual native catalog/);
  assert.throws(() => graphModel.graphCatalogEvidence([{ ...ready, stage: 'before_agent_start' }], config), /actual provider system payload/);
  assert.equal(graphModel.graphCatalogEvidence([pending], config).status, 'pending');
  assert.equal(graphModel.graphCatalogEvidence([pending, { phase: 'provider-request', contents: [{ role: 'entrypoint', ownerId: 'root' }] }], config).status, 'pending');
  assert.equal(graphModel.graphCatalogEvidence([pending, ready], config).status, 'ready');
  assert.throws(() => graphModel.graphCatalogEvidence([{ ...pending, state: 'unavailable' }], config), /unavailable/);
  assert.throws(() => graphModel.graphCatalogEvidence([{ ...ready, routers: [] }], config), /selected root/);
  assert.throws(() => graphModel.graphCatalogEvidence([{ ...ready, routers: [{ ...ready.routers[0], canonicalRef: 'skill://wrong/ROUTER.md' }] }], config), /selected root/);
  assert.throws(() => graphModel.graphCatalogEvidence([{ ...ready, routers: [{ ...ready.routers[0], provenance: null }] }], config), /metadata/);
});

test('task evidence records actual project and selected-resource reads independently of final claims', () => {
  const claimed = { phase: 'assistant-final', success: true, text: '已读取项目源码。' };
  const missing = graphModel.graphTaskEvidence([claimed]);
  assert.equal(missing.projectSourceReadCount, 0); assert.equal(missing.projectSourceReadStatus, 'missing');
  assert.equal(missing.finalTextSha256, hash(claimed.text));
  const observed = graphModel.graphTaskEvidence([claimed, { phase: 'project-read-result', complete: true, path: 'src/tickets.mjs', toolCallId: 'p' }, { phase: 'tool-result', complete: true, role: 'resource', toolCallId: 'r', ref: 'skill://member/README.md' }]);
  assert.equal(observed.projectSourceReadCount, 1); assert.equal(observed.projectSourceReadStatus, 'observed');
  assert.equal(observed.resourceReadCount, 1);
  const batch = graphModel.graphTaskEvidence([{ phase: 'tool-result', complete: true, role: 'resource', toolCallId: 'batch', ref: 'one' },
    { phase: 'tool-result', complete: true, role: 'resource', toolCallId: 'batch', ref: 'two' }]);
  assert.equal(batch.resourceReadCount, 2); assert.equal(batch.resourceToolCallCount, 1);
});

test('batch resources retain one exact outer provider output and cannot pass on standalone body copies or details', () => {
  const value = contractFixture('B'), resource = value.trace.reads[1];
  resource.role = 'resource'; resource.toolCallId = 'batch';
  resource.resourceBatchProof = { index: 0, publicRequestId: 'actual-sdk-batch', deliveryVerified: true,
    selection: { owner: 'fixture-leaf', scope: resource.scope, snapshot_id: resource.snapshot },
    delivery: { encoding: 'json', start: 10, end: 10 + resource.content.length },
    toolResultSha256: hash('complete-batch-output'), toolResultBytes: 1000 };
  value.trace.providerRequests.at(-1).toolResults = [{ toolCallId: 'batch', tool: 'read', exactToolOutputCopies: 1,
    sha256: resource.resourceBatchProof.toolResultSha256, bytes: 1000,
    records: [{ ref: resource.ref, scope: resource.scope, snapshot: resource.snapshot, sha256: resource.sha256, bytes: resource.bytes, providerCopies: 1 }] }];
  assert.equal(evaluateGraphTrace(value.trace, value.oracle).status, 'contract-valid');
  for (const mutate of [v => { v.trace.providerRequests.at(-1).toolResults = []; },
    v => { v.trace.providerRequests.at(-1).toolResults[0].exactToolOutputCopies = 0; },
    v => { v.trace.providerRequests.at(-1).toolResults[0].toolCallId = 'another'; },
    v => { v.trace.providerRequests.at(-1).toolResults[0].records[0].providerCopies = 0; },
    v => { v.trace.reads[1].resourceBatchProof.deliveryVerified = false; },
    v => { v.trace.reads[1].resourceBatchProof.selection.owner = 'another'; }]) {
    const changed = structuredClone(value); mutate(changed);
    assert.throws(() => evaluateGraphTrace(changed.trace, changed.oracle), error => error.code === 'PROVIDER_CONTENT');
  }
});

test('agent-cli-ref-20261105 freezes Notion model tools and defaults to bundled SDK', async () => {
  assert.deepEqual(GRAPH_GATE_TOOLS, ['read', 'notion_list', 'notion_use']);
  const fixture = await workerConfigFixture();
  const config = await readGateConfig(fixture.configPath);
  assert.equal(config.sourceMode, 'sdk');
  const source = graphModel.brokerConfiguration(config, ['/owned/observed-command'], '/owned/cache').sources[0];
  assert.equal(Object.hasOwn(source, 'command'), false);
  assert.equal(source.default_view_id, uuid);
  fixture.config.sourceMode = 'command'; await fixture.write();
  const legacy = await readGateConfig(fixture.configPath);
  assert.deepEqual(graphModel.brokerConfiguration(legacy, ['/owned/observed-command'], '/owned/cache').sources[0].command, ['/owned/observed-command']);
});

test('default SDK cannot silently accept a profile-only source or unknown transport', async () => {
  const fixture = await workerConfigFixture();
  delete fixture.config.viewId; fixture.config.profileId = 'legacy-profile'; await fixture.write();
  await assert.rejects(readGateConfig(fixture.configPath), /Profile.*explicit.*command/);
  fixture.config.sourceMode = 'command'; await fixture.write();
  assert.equal((await readGateConfig(fixture.configPath)).sourceMode, 'command');
  fixture.config.sourceMode = 'automatic-fallback'; await fixture.write();
  await assert.rejects(readGateConfig(fixture.configPath), /sourceMode/);
});

async function workerConfigFixture() {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-worker-authorization-'));
  const config = { version: 1, gate: 'B', selection: '$poteto-mode@notion', rootRef: 'skill://controlled-ordinary/SKILL.md', database: uuid, viewId: uuid,
    extension: path.join(base, 'installed/index.ts'), packagePath: path.join(base, 'package.tgz'), cliCommand: [process.execPath, path.join(base, 'installed/cli.mjs')],
    oraclePath: path.join(base, 'oracle.json'), evidenceRoot: path.join(base, 'evidence'), model: 'magpie/group/worker', previousFailures: [], mode: 'matrix' };
  const receipt = { version: 1, kind: 'explicit-user-worker-authorization', model: 'magpie/group/worker',
    scope: { gate: config.gate, rootRef: config.rootRef, promptSha256: frozenPrompt(config.gate, config.selection).sha256 },
    authorizationQuestion: 'Controlled fixture: authorize worker after a flash-free task failure without changing the contract?', userReply: 'Controlled fixture: continue.' };
  const configPath = path.join(base, 'config.json'), authorizationPath = path.join(base, 'authorization.json');
  const write = async () => {
    await save(authorizationPath, receipt);
    config.workerAuthorization = { path: authorizationPath, sha256: hash(await readFile(authorizationPath)) };
    await save(configPath, config);
  };
  await write();
  return { base, config, receipt, configPath, authorizationPath, write };
}

test('explicit worker authorization retains exact scope and evidence without inventing an availability failure', async () => {
  const value = await workerConfigFixture(), parsed = await readGateConfig(value.configPath);
  assert.equal(parsed.model, 'magpie/group/worker');
  assert.deepEqual(parsed.previousFailures, []);
  assert.equal(parsed.workerAuthorization.raw, await readFile(value.authorizationPath, 'utf8'));
  assert.equal(parsed.workerAuthorization.sha256, value.config.workerAuthorization.sha256);
  assert.deepEqual(parsed.prompt, frozenPrompt(value.config.gate, value.config.selection));
  assert.ok(!parsed.prompt.text.includes(value.receipt.authorizationQuestion));
  const fixture = attributionFixture(['file-root']);
  fixture.config.workerAuthorization = parsed.workerAuthorization;
  const trace = graphTrace(fixture);
  assert.deepEqual(trace.model.workerAuthorization, parsed.workerAuthorization);
  assert.ok(!JSON.stringify(trace.providerRequests).includes(value.receipt.authorizationQuestion));
});

test('worker authorization does not turn a task failure into an availability failure', async () => {
  const value = await workerConfigFixture(), prior = path.join(value.base, 'prior.json');
  await save(prior, { model: 'magpie/group/flash-free', status: 'failed', availabilityFailure: false });
  delete value.config.workerAuthorization; value.config.previousFailures = [prior]; await save(value.configPath, value.config);
  await assert.rejects(readGateConfig(value.configPath), /task\/assertion failure does not authorize model fallback/);
  await value.write();
  await assert.rejects(readGateConfig(value.configPath), /task\/assertion failure does not authorize model fallback/);
  delete value.config.workerAuthorization; value.config.previousFailures = []; await save(value.configPath, value.config);
  await assert.rejects(readGateConfig(value.configPath), /Worker requires/);
  await save(prior, { model: 'magpie/group/flash-free', status: 'failed', availabilityFailure: true });
  value.config.previousFailures = [prior]; await save(value.configPath, value.config);
  assert.equal((await readGateConfig(value.configPath)).previousFailures.length, 1);
});

test('explicit worker authorization rejects changed bytes, wrong scope, another model and unknown fields', async () => {
  const value = await workerConfigFixture();
  const original = structuredClone(value.receipt);
  for (const mutate of [receipt => { receipt.model = 'another/model'; }, receipt => { receipt.scope.gate = 'A'; },
    receipt => { receipt.scope.rootRef = 'skill://another-root/SKILL.md'; }, receipt => { receipt.scope.promptSha256 = 'a'.repeat(64); },
    receipt => { receipt.allowAnything = true; }, receipt => { receipt.scope.allRoots = true; }, receipt => { receipt.userReply = ''; }]) {
    for (const key of Object.keys(value.receipt)) delete value.receipt[key]; Object.assign(value.receipt, structuredClone(original));
    mutate(value.receipt); await value.write();
    await assert.rejects(readGateConfig(value.configPath), { code: 'MODEL_AUTHORIZATION' });
  }
  for (const key of Object.keys(value.receipt)) delete value.receipt[key]; Object.assign(value.receipt, original); await value.write();
  await writeFile(value.authorizationPath, (await readFile(value.authorizationPath, 'utf8')) + ' ');
  await assert.rejects(readGateConfig(value.configPath), { code: 'MODEL_AUTHORIZATION' });
  await value.write(); value.config.workerAuthorization.extra = true; await save(value.configPath, value.config);
  await assert.rejects(readGateConfig(value.configPath));
  await value.write(); value.config.model = 'another/model'; await save(value.configPath, value.config);
  await assert.rejects(readGateConfig(value.configPath), /No third model/);
});



test('prompt timeout defaults to the original budget and explicit default preserves cache identity', async () => {
  const value = await workerConfigFixture(), implicit = await readGateConfig(value.configPath);
  assert.equal(implicit.promptTimeoutMs, 300000);
  value.config.promptTimeoutMs = 300000; await value.write();
  const explicit = await readGateConfig(value.configPath);
  const doctor = { harness: { sha256: hash('harness') }, cli: { sha256: hash('cli') }, extension: { sha256: hash('extension') }, package: { sha256: hash('package') } };
  assert.equal(graphModel.runFingerprint(implicit, doctor, hash('oracle'), hash('project')),
    graphModel.runFingerprint(explicit, doctor, hash('oracle'), hash('project')));
});

test('an explicit prompt timeout is frozen without changing the task or worker authorization and changes cache identity', async () => {
  const value = await workerConfigFixture(), original = await readGateConfig(value.configPath);
  value.config.promptTimeoutMs = 600000; await value.write();
  const parsed = await readGateConfig(value.configPath);
  assert.equal(parsed.promptTimeoutMs, 600000);
  assert.deepEqual(parsed.prompt, original.prompt);
  assert.deepEqual(parsed.workerAuthorization, original.workerAuthorization);
  const doctor = { harness: { sha256: hash('harness') }, cli: { sha256: hash('cli') }, extension: { sha256: hash('extension') }, package: { sha256: hash('package') } };
  assert.notEqual(graphModel.runFingerprint(parsed, doctor, hash('oracle'), hash('project')),
    graphModel.runFingerprint(original, doctor, hash('oracle'), hash('project')));
});

test('prompt timeout rejects invalid timer values instead of silently selecting a different budget', async () => {
  const value = await workerConfigFixture();
  for (const timeout of [null, 0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER, '600000', true]) {
    value.config.promptTimeoutMs = timeout; await value.write();
    await assert.rejects(readGateConfig(value.configPath), /promptTimeoutMs must be a positive safe timer integer/);
  }
  for (const timeout of [1, 2147483647]) {
    value.config.promptTimeoutMs = timeout; await value.write();
    assert.equal((await readGateConfig(value.configPath)).promptTimeoutMs, timeout);
  }
});

test('matrix accounting retains a timed-out continued sample and records the remaining unstarted design', () => {
  const design = { order: ['cold', 'warm-new-process', 'warm-new-process', 'continued-session', 'continued-session'] };
  const samples = design.order.slice(0, 4).map((mode, index) => ({ mode, status: index === 3 ? 'failed' : 'passed',
    ...(index === 3 ? { error: { code: 'NATIVE_SUBMISSION_FAILED', message: 'pi: prompt completion timed out after 300000ms' } } : {}) }));
  const before = JSON.stringify(samples);
  const unstarted = graphModel.unstartedMatrixSamples({ design, samples, notRun: [] });
  assert.equal(unstarted.length, 1);
  assert.equal(unstarted[0].mode, 'continued-session');
  assert.match(unstarted[0].reason, /before this scheduled sample started/);
  assert.equal(JSON.stringify(samples), before);
  assert.deepEqual(graphModel.unstartedMatrixSamples({ design, samples: [...samples, { mode: 'continued-session', status: 'failed' }], notRun: [] }), []);
  const previous = [{ mode: 'warm-new-process', reason: 'No complete successful prior consumer cache receipt exists' }];
  assert.equal(graphModel.unstartedMatrixSamples({ design, samples: samples.slice(0, 1), notRun: previous }), previous);
});

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

function authoredSelectionFixture() {
  const value = attributionFixture(['file-member']), owner = value.oracle.target.logicalId, scope = value.oracle.target.scope;
  const input = { path: value.oracle.target.ref }, argumentsSha256 = hash(JSON.stringify(input));
  const identity = { scope, ownerId: owner, path: 'SKILL.md', snapshot: 'snapshot-member', fileId: 'file-member', sha256: hash('member'), bytes: 6 };
  const author = { phase: 'authored-tool-call', source: 'assistant-message-end', at: '2026-01-01T00:00:00.050Z', sequence: 2,
    toolCallId: 'native-read', tool: 'read', input, argumentsSha256, discovered: true };
  const admission = { phase: 'tool-call', at: '2026-01-01T00:00:00.950Z', sequence: 3, toolCallId: author.toolCallId, tool: 'read',
    input: input.path, argumentsSha256, authoredSequence: author.sequence, origin: 'model', allowed: true, expected: identity };
  const read = { phase: 'tool-result', at: '2026-01-01T00:00:01.050Z', sequence: 4, callSequence: admission.sequence, toolCallId: author.toolCallId,
    tool: 'read', logicalId: owner, ...identity, complete: true, ref: value.oracle.target.ref, content: 'member' };
  value.observation.push(author, admission, read);
  return { value, author, admission, read };
}

test('H6 A: selection uses the observed authored call before Broker awaits source reads, while preserving later admission', () => {
  const { value, author, admission } = authoredSelectionFixture();
  const trace = graphTrace(value);
  assert.equal(trace.memberBodyReadsBeforeSelection, 0);
  assert.equal(trace.httpAttempts.find(attempt => attempt.kind === 'body').beforeSelection, false);
  assert.ok(Date.parse(author.at) < Date.parse(value.sourceLedger[0].at));
  assert.ok(Date.parse(admission.at) > Date.parse(value.sourceLedger[0].at));
  assert.equal(value.observation.find(event => event.phase === 'tool-call').at, admission.at);
});

test('authored timing cannot authorize an undiscovered, changed, mismatched or genuinely early source read', () => {
  for (const mutate of [f => { f.author.discovered = false; }, f => { f.author.toolCallId = 'another-call'; },
    f => { f.author.tool = 'skill_prepare'; }, f => { f.author.input.path = 'skill://another-owner/SKILL.md'; },
    f => { f.author.argumentsSha256 = 'a'.repeat(64); }, f => { f.admission.authoredSequence = 99; },
    f => { f.admission.expected.scope = 'another-scope'; }, f => { f.admission.expected.fileId = 'another-file'; },
    f => { f.admission.allowed = false; }, f => { f.value.sourceLedger[0].at = '2026-01-01T00:00:00.010Z'; }]) {
    const f = authoredSelectionFixture(); mutate(f);
    assert.equal(graphTrace(f.value).memberBodyReadsBeforeSelection, 1);
  }
});

function submittedNameSelectionFixture() {
  const f = authoredSelectionFixture(), selector = 'visible-member', prompt = '请介绍 visible-member。';
  const provider = f.value.observation[0];
  provider.observedPayloadSha256 = hash('actual frozen payload');
  provider.sourceTextHashes = [{ sha256: hash(prompt), bytes: Buffer.byteLength(prompt) }];
  const claim = { kind: 'submitted-name', selector, path: 'SKILL.md', promptSha256: hash(prompt), promptSequence: provider.sequence,
    providerPayloadSha256: provider.observedPayloadSha256, span: { start: 4, end: 18 }, sourceFilesBefore: [] };
  f.author.input = { path: 'skill://' + selector + '/SKILL.md' };
  f.author.argumentsSha256 = hash(JSON.stringify(f.author.input)); f.author.nameSelection = { claim: structuredClone(claim) };
  f.admission.input = f.author.input.path; f.admission.argumentsSha256 = f.author.argumentsSha256;
  delete f.admission.expected; f.admission.claim = claim;
  f.read.nameResolution = { selector, promptSha256: claim.promptSha256, promptSequence: claim.promptSequence,
    selectionRequestId: 'named-catalog', readRequestId: 'named-read' };
  const sourceRead = f.value.responses.find(item => item.command === 'read' && item.response.record.id === f.read.ownerId);
  sourceRead.requestId = 'named-read'; sourceRead.response.path = f.read.path; sourceRead.response.content = f.read.content;
  Object.assign(sourceRead.response.record, { name: 'Visible member', alias: selector, kind: 'skill', entrypoint: 'SKILL.md' });
  const catalog = { requestId: 'named-catalog', command: 'list', code: 0, response: { ok: true, scope: f.read.scope,
    count: 1, records: [structuredClone(sourceRead.response.record)],
    coverage: { method: 'explicit_database', exhaustive: true, search_index_limited: false, failed_sources: [] } }, metrics: { complete: true, trace: [] } };
  f.value.responses.push(catalog);
  return { ...f, catalog, sourceRead, provider };
}

test('submitted-name source attribution uses the original authored time only after its catalog and read bind the name', () => {
  const f = submittedNameSelectionFixture();
  assert.equal(graphTrace(f.value).memberBodyReadsBeforeSelection, 0);
  for (const mutate of [
    v => { delete v.read.nameResolution; },
    v => { v.author.nameSelection.claim.selector = 'another-name'; },
    v => { v.read.nameResolution.selectionRequestId = 'not-observed'; },
    v => { v.read.nameResolution.readRequestId = 'not-observed'; },
    v => { v.read.nameResolution.promptSha256 = hash('another request'); },
    v => { v.provider.observedPayloadSha256 = hash('another payload'); },
    v => { v.catalog.response.scope = 'another-scope'; },
    v => { v.catalog.response.coverage.exhaustive = false; },
    v => { v.catalog.response.coverage.failed_sources.push({ id: 'failed', code: 'API_ERROR' }); },
    v => { v.sourceRead.response.record.id = 'shared_skill:controlled:another'; },
    v => { v.sourceRead.response.path = 'another.md'; },
    v => { v.value.sourceLedger[0].at = '2026-01-01T00:00:00.010Z'; },
  ]) {
    const changed = submittedNameSelectionFixture(); mutate(changed);
    assert.notEqual(graphTrace(changed.value).memberBodyReadsBeforeSelection, 0);
  }
});

test('retained ownership requires a verified manifest and its bundle in the same actual receipt, without inventing consumption', () => {
  const scope = 'a'.repeat(64), libraryId = 'library-992754f7-01c1-4ad1-a492-81f6f35d4ed6';
  const archive = 'controlled immutable archive', digest = hash(archive), chunkId = 'chunk-' + digest;
  const value = attributionFixture([chunkId]);
  const ownerPage = uuid.replace('11111111', '33333333');
  for (const receipt of value.responses) {
    receipt.response.scope = scope;
    if (receipt.command === 'read') Object.assign(receipt.response.record.locator, { type: 'shared_skill', library_id: libraryId,
      page_id: receipt.response.file_bindings[0].page_id, database_id: uuid });
  }
  for (const node of value.responses[0].response.nodes) node.record.locator.library_id = libraryId;
  value.oracle.target.scope = scope;
  for (const item of value.oracle.preparations.B) item.scope = scope;
  for (const item of value.observation[0].contents) item.scope = scope;
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  const payload = { version: 1, kind: 'retained_bundle', library_id: libraryId, skill_page_id: ownerPage, entrypoint: 'SKILL.md',
    files: [{ path: 'SKILL.md', bytes: 6, sha256: hash('member') }], archive: { format: 'zip', bytes: Buffer.byteLength(archive), sha256: digest,
      chunks: [{ object_id: chunkId, sha256: digest, bytes: Buffer.byteLength(archive) }] } };
  const bundle = 'bundle-' + hash(canonical(payload)), operation = 'retain-' + bundle;
  const proof = { version: 1, kind: 'retained-source-ownership', status: 'verified', scope, library_id: libraryId,
    records_data_source_id: uuid, records: [{ page_id: uuid.replace('11111111', '44444444'), record_id: bundle, operation_id: operation,
      kind: 'source', entity_id: bundle, hash: hash(canonical({ version: 1, operation_id: operation, payload })), payload, skill_page_id: ownerPage }] };
  value.retainedSourceProofs = [proof];
  assert.equal(graphTrace(value).memberBodyReadsBeforeSelection, null, 'A global proof alone cannot attribute this request');
  const metadata = { event: 'attempt', request_kind: 'notion_metadata', http_status: 200, request_id: 'actual-bundle',
    request_bytes: 1, response_bytes: 1, target: { data_source_id: uuid, entity_ids: [bundle] } };
  value.responses[1].metrics.trace.push(metadata);
  assert.equal(graphTrace(value).memberBodyReadsBeforeSelection, null, 'Another CLI receipt cannot lend its bundle observation');
  value.responses[0].metrics.trace.unshift(metadata);
  const early = graphTrace(value);
  assert.equal(early.memberBodyReadsBeforeSelection, 1);
  assert.equal(early.reads.length, 0, 'Retained ZIP membership is not a model native read');
  assert.equal(early.providerRequests[0].contents.length, 2, 'Supplementary ownership cannot add provider bodies');
  assert.deepEqual(early.httpAttempts.find(attempt => attempt.kind === 'body').retainedSourceProofs, [bundle]);
  const unproven = graphTrace({ ...value, retainedSourceProofs: [] });
  const input = retainedSourceProofInput({ gate: 'B', evidence: '/owned/evidence', trace: unproven, responses: value.responses });
  assert.deepEqual(input.runs[0].bundle_ids, [bundle]);
  assert.deepEqual(input.runs[0].unattributed_retained_attempts[0].target.entity_ids, [chunkId]);
  value.observation.push({ phase: 'tool-call', toolCallId: 'selected', at: '2026-01-01T00:00:00.050Z', sequence: 2, origin: 'model', allowed: true },
    { phase: 'tool-result', toolCallId: 'selected', sequence: 3, callSequence: 2, ownerId: value.oracle.target.logicalId,
      logicalId: value.oracle.target.logicalId, scope, ref: value.oracle.target.ref, complete: true });
  assert.equal(graphTrace(value).memberBodyReadsBeforeSelection, 0);
  value.responses[0].metrics.trace[0] = { ...metadata, target: { ...metadata.target, data_source_id: uuid.replace('11111111', '99999999') } };
  assert.equal(graphTrace(value).memberBodyReadsBeforeSelection, null, 'A bundle from another Records source must remain unknown');
});

test('later provider requests cannot duplicate or change an already selected Required body', () => {
  const value = attributionFixture(['file-root']);
  const next = structuredClone(value.observation[0]); next.sequence = 4;
  value.observation.push(next);
  assert.equal(graphTrace(value).memberBodyReadsBeforeSelection, 0);
  next.contents.push(structuredClone(next.contents[1]));
  assert.throws(() => graphTrace(value), /unique and on the selected version/);
  next.contents.pop(); next.contents[1].snapshot = 'unselected-version';
  assert.throws(() => graphTrace(value), /unique and on the selected version/);
});

test('the installed observer policy admits actual owned source reads and blocks undiscovered local paths', async () => {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-observer-policy-'));
  const project = await createOwnedGraphProject(path.join(base, 'project'));
  const responses = path.join(base, 'responses'), cache = path.join(base, 'cache'), output = path.join(base, 'observer.jsonl');
  await mkdir(responses); await mkdir(cache); await writeFile(output, '');
  const handlers = new Map(), originalFetch = globalThis.fetch;
  try {
    observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async () => {} }, { fs, crypto, path, parseNativeReference, project, cwd: project.root, responses, cache, output, rootRef: 'skill://controlled-root/SKILL.md', model: 'controlled/fake', prompt: 'controlled task' });
    handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'project', name: 'read', arguments: { path: 'src/tickets.mjs' } }] } });
    assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'project', input: { path: 'src/tickets.mjs' } }), undefined);
    const content = await readFile(path.join(project.root, 'src/tickets.mjs'), 'utf8');
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'project', content: [{ type: 'text', text: content }] });
    const alias = path.join(base, 'os-alias');
    await symlink(project.root, alias, 'dir');
    const aliasPath = path.join(alias, 'src/tickets.mjs');
    handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'alias', name: 'read', arguments: { path: aliasPath } }] } });
    assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'alias', input: { path: aliasPath } }), undefined);
    handlers.get('tool_result')({ toolName: 'read', toolCallId: 'alias', content: [{ type: 'text', text: content }] });
    await symlink(path.join(project.root, 'src/tickets.mjs'), path.join(project.root, 'internal-link.mjs'));
    handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'internal-link', name: 'read', arguments: { path: 'internal-link.mjs' } }] } });
    assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'internal-link', input: { path: 'internal-link.mjs' } }).block, true);
    handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'outside', name: 'read', arguments: { path: path.join(base, 'private-oracle.json') } }] } });
    assert.equal(handlers.get('tool_call')({ toolName: 'read', toolCallId: 'outside', input: { path: path.join(base, 'private-oracle.json') } }).block, true);
    const events = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(event => event.phase === 'project-read-result' && event.complete && event.sourceSha256 === hash(content)));
    assert.ok(events.some(event => event.phase === 'tool-call' && event.category === 'blocked' && !event.allowed));
  } finally { globalThis.fetch = originalFetch; }
});

test('actual metadata may introduce an exact ref while guessed roots, forged results and shell stay blocked', async () => {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-observer-tools-'));
  const project = await createOwnedGraphProject(path.join(base, 'project'));
  const responses = path.join(base, 'responses'), cache = path.join(base, 'cache'), output = path.join(base, 'observer.jsonl');
  await mkdir(responses); await mkdir(cache); await writeFile(output, '');
  const record = { id: 'shared_skill:controlled:member', ref: 'skill://shared_skill%3Acontrolled%3Amember/SKILL.md', kind: 'skill', name: 'member', description: 'Controlled metadata', enabled: true };
  const scope = 'a'.repeat(64);
  await save(path.join(responses, 'list.json'), { command: 'list', code: 0, response: { ok: true, scope, records: [record] } });
  const handlers = new Map(), originalFetch = globalThis.fetch;
  let active;
  try {
    const model = { model: { provider: 'controlled', id: 'fake' } };
    observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async tools => { active = tools; } }, { fs, crypto, path, parseNativeReference, project, cwd: project.root, responses, cache, output, rootRef: 'skill://controlled-root/SKILL.md', model: 'controlled/fake', prompt: 'controlled task' });
    await handlers.get('session_start')({}, model);
    assert.deepEqual(active, GRAPH_GATE_TOOLS);
    const invoke = (id, name, arguments_) => {
      handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: arguments_ }] } });
      return handlers.get('tool_call')({ toolName: name, toolCallId: id, input: arguments_ });
    };
    assert.equal(invoke('unknown', 'notion_use', { ref: record.ref }).block, true);
    assert.equal(invoke('legacy-search', 'skill_search', { query: 'member' }).block, true);
    assert.equal(invoke('legacy-prepare', 'skill_prepare', { roots: [record.ref], purpose: 'use' }).block, true);
    assert.equal(invoke('search', 'notion_list', { query: 'member' }), undefined);
    const result = { ok: true, state: 'known', count: 1, total_count: 1, has_more: false, next_cursor: null,
      coverage: { exhaustive: true, sources: ['notion'] }, records: [{ ...record, source: 'notion', scope, in_default_view: false, availability: 'available' }], failures: [] };
    delete result.records[0].enabled;
    const projection = result => ({ ...result, records: result.records.map(({ id, scope, ...row }) => row) });
    const content = JSON.stringify(projection(result));
    handlers.get('tool_result')({ toolName: 'notion_list', toolCallId: 'search', content: [{ type: 'text', text: content }], details: result, isError: false });
    assert.equal(invoke('prepare', 'notion_use', { ref: record.ref }), undefined);
    assert.equal(invoke('multiple', 'notion_use', { ref: [record.ref] }), undefined);
    assert.equal(invoke('inspect', 'read', { path: record.ref }), undefined);
    assert.equal(invoke('hidden-inspect', 'notion_use', { ref: record.ref, purpose: 'inspect' }).block, true);
    assert.equal(invoke('guessed', 'notion_use', { ref: 'member' }).block, true);
    assert.equal(invoke('guessed-cursor', 'notion_list', { cursor: '1.' + hash('unobserved') }).block, true);
    assert.equal(invoke('shell', 'bash', { command: 'echo should-never-run' }).block, true);
    assert.equal(handlers.get('tool_call')({ toolName: 'notion_list', toolCallId: 'unattributed', input: { query: '' } }).block, true);
    const tools = GRAPH_GATE_TOOLS.map(name => ({ type: 'function', function: { name } }));
    handlers.get('before_provider_request')({ payload: { tools, messages: [{ role: 'tool', tool_call_id: 'search', content }] } }, model);
    assert.throws(() => handlers.get('before_provider_request')({ payload: { tools: tools.slice(0, 1), messages: [] } }, model), /advertise/);
    assert.equal(invoke('forged', 'notion_list', { query: 'forged' }), undefined);
    const forgedRef = 'skill://shared_skill%3Acontrolled%3Aforged/SKILL.md';
    const forged = { ...result, records: [{ ...result.records[0], ref: forgedRef, id: 'shared_skill:controlled:forged' }] };
    handlers.get('tool_result')({ toolName: 'notion_list', toolCallId: 'forged', content: [{ type: 'text', text: JSON.stringify(projection(forged)) }], details: forged });
    assert.equal(invoke('forged-prepare', 'notion_use', { ref: forgedRef }).block, true);
    const events = (await readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some(event => event.phase === 'metadata-result' && event.toolCallId === 'forged' && event.complete === false));
    assert.ok(events.some(event => event.phase === 'provider-request' && event.toolResults.some(result => result.toolCallId === 'search' && result.exactToolOutputCopies === 1 && result.sha256 === hash(content))));
    assert.equal(events.filter(event => event.phase === 'tool-result' && event.complete).length, 0, 'Metadata discovery does not count as a body load');
  } finally { globalThis.fetch = originalFetch; }
});

test('only explicitly selected prepared mains with full public and provider proofs satisfy the same read contract', () => {
  const value = contractFixture('B'), main = value.trace.reads[0];
  value.trace.toolContract = 'agent-cli-ref-20261105';
  main.tool = 'notion_use'; main.toolCallId = 'explicit-main'; main.role = 'entrypoint'; main.bytes = Buffer.byteLength(main.content);
  main.preparationProof = { purpose: 'use', explicitRoot: true, roots: ['skill://' + encodeURIComponent(main.logicalId) + '/SKILL.md'], publicRequestId: 'actual-public-request',
    graphLockSha256: hash('lock'), manifestSha256: hash('manifest'), publicRef: main.ref, scope: main.scope,
    ownerId: main.logicalId, snapshot: main.snapshot, sha256: main.sha256, bytes: main.bytes,
    toolResultSha256: hash('complete-json-result'), toolResultBytes: main.bytes + 1000, deliveryVerified: true };
  value.trace.providerRequests.at(-1).toolResults = [{ toolCallId: main.toolCallId, tool: main.tool,
    sha256: main.preparationProof.toolResultSha256, bytes: main.preparationProof.toolResultBytes,
    records: [{ ref: main.ref, scope: main.scope, snapshot: main.snapshot, sha256: main.sha256, bytes: main.bytes, providerCopies: 1 }] }];
  assert.equal(evaluateGraphTrace(value.trace, value.oracle).status, 'contract-valid');
  for (const mutate of [
    v => { v.trace.reads[0].preparationProof.explicitRoot = false; },
    v => { v.trace.reads[0].preparationProof.graphLockSha256 = ''; },
    v => { v.trace.reads[0].preparationProof.snapshot = 'other'; },
    v => { v.trace.providerRequests.at(-1).toolResults[0].records[0].providerCopies = 0; },
    v => { v.trace.reads[1].tool = 'notion_use'; },
    v => { v.trace.reads[0].preparationProof.purpose = 'inspect'; },
    v => { v.trace.reads[0].tool = 'skill_prepare'; v.trace.providerRequests.at(-1).toolResults[0].tool = 'skill_prepare'; },
  ]) {
    const changed = structuredClone(value); mutate(changed);
    assert.throws(() => evaluateGraphTrace(changed.trace, changed.oracle), error => error.code === 'NAME_GUESSING');
  }
});

async function literalObserverFixture(body, transport, selectedSurface, fileId, options = {}) {
  const directory = await mkdtemp(path.join(await systemTempRoot(), 'graph-literal-observer-'));
  const cache = path.join(directory, 'cache'), responses = path.join(directory, 'responses'), output = path.join(directory, 'observer.jsonl');
  const owner = 'shared_skill:controlled:literal-root', scope = 'a'.repeat(64), snapshot = 's_' + hash(body);
  const root = path.join(cache, 'scopes', scope, 'records', hash(owner), 'snapshots', snapshot);
  await mkdir(cache); await mkdir(responses); await writeFile(output, '');
  const record = { id: owner, kind: 'skill', ...(options.record ?? {}) };
  const publish = async () => {
    await mkdir(root, { recursive: true }); await writeFile(path.join(root, 'SKILL.md'), body);
    await save(path.join(root, '.broker-snapshot.json'), { version: 3, projection: 'snapshot', scope, snapshot, entry: 'SKILL.md', record, files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(body), hash: hash(body) }] });
    await save(path.join(responses, 'read.json'), { requestId: 'literal-public-read', command: 'read', code: 0, response: { ok: true, scope, snapshot_id: snapshot, version_id: hash(body), path: 'SKILL.md', record, content: body, ...(fileId ? { file_bindings: [{ file_id: fileId, page_id: uuid, path: 'SKILL.md' }] } : {}) } });
  };
  if (!options.deferred) await publish();
  const toolSurfaceFile = selectedSurface ? path.join(directory, 'frozen-surface.json') : undefined;
  if (toolSurfaceFile) await save(toolSurfaceFile, { surface: selectedSurface });
  const handlers = new Map(), originalFetch = globalThis.fetch;
  if (transport) globalThis.fetch = transport;
  observeGraphGate({ on: (event, handler) => handlers.set(event, handler), setActiveTools: async () => {} }, { fs, crypto, path, parseNativeReference, cwd: directory, nativeHome: directory, responses, cache, output,
    ...(options.deferred ? { entryMode: 'discovery-only' } : { rootRef: 'skill://' + encodeURIComponent(owner) + '/SKILL.md' }), model: 'controlled/fake', prompt: options.prompt ?? 'controlled task', ...(toolSurfaceFile ? { toolSurfaceFile } : {}) });
  const tools = GRAPH_GATE_TOOLS.map(name => ({ type: 'function', function: { name } }));
  const payload = content => ({ model: 'fake', tools, messages: [{ role: 'user', content }] });
  return { handlers, payload, toolSurfaceFile, directory, root, owner, scope, snapshot, record, responses, publish, ctx: { model: { provider: 'controlled', id: 'fake' } },
    events: async () => (await readFile(output, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
    close: () => { globalThis.fetch = originalFetch; } };
}

const nameCatalog = fixture => ({ requestId: 'new-name-selection', command: 'list', code: 0,
  response: { ok: true, scope: fixture.scope, count: 1, records: [fixture.record], coverage: { method: 'explicit_database', exhaustive: true, failed_sources: [], search_index_limited: false } } });

for (const selector of ['Visible Skill', 'visible-skill']) test('an actual frozen user name permits only a current main attempt before catalogue discovery: ' + selector, async () => {
  const body = 'Complete introduced instructions.\n', prompt = '请介绍 ' + selector + '。';
  const fixture = await literalObserverFixture(body, undefined, undefined, undefined, { deferred: true, prompt,
    record: { name: 'Visible Skill', alias: 'visible-skill', enabled: true, entrypoint: 'SKILL.md', ref: 'skill://shared_skill%3Acontrolled%3Aliteral-root/SKILL.md' } });
  const input = 'skill://' + encodeURIComponent(selector) + '/SKILL.md';
  const invoke = (id, target = input, tool = 'read') => {
    const args = tool === 'read' ? { path: target } : { ref: target };
    fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name: tool, arguments: args }] } });
    return fixture.handlers.get('tool_call')({ toolName: tool, toolCallId: id, input: args });
  };
  try {
    assert.equal(invoke('not-yet-submitted').block, true);
    fixture.handlers.get('before_provider_request')({ payload: fixture.payload(prompt) }, fixture.ctx);
    assert.equal(invoke('unselected-use', input, 'notion_use').block, true);
    assert.equal(invoke('guessed-resource', input.replace('/SKILL.md', '/references/guess.md')).block, true);
    assert.equal(invoke('guessed-pin', input + '?snapshot=' + fixture.snapshot).block, true);
    assert.equal(invoke('named-main'), undefined);
    const before = (await fixture.events()).find(event => event.phase === 'tool-call' && event.toolCallId === 'named-main');
    assert.equal(before.claim.kind, 'submitted-name'); assert.equal(before.claim.selector, selector);
    assert.equal(before.claim.ownerId, undefined); assert.equal(before.input, input);
    assert.equal(before.claim.promptSha256, hash(prompt));
    await save(path.join(fixture.responses, 'name-selection.json'), nameCatalog(fixture));
    await fixture.publish();
    fixture.handlers.get('tool_result')({ toolName: 'read', toolCallId: 'named-main', content: [{ type: 'text', text: body }] });
    const read = (await fixture.events()).find(event => event.phase === 'tool-result' && event.toolCallId === 'named-main');
    assert.equal(read.complete, true); assert.equal(read.ownerId, fixture.owner); assert.equal(read.scope, fixture.scope);
    assert.equal(read.requested, input); assert.equal(read.nameResolution.selectionRequestId, 'new-name-selection');
    assert.equal(read.nameResolution.readRequestId, 'literal-public-read');
    fixture.handlers.get('before_provider_request')({ payload: { ...fixture.payload(prompt), messages: [{ role: 'user', content: prompt }, { role: 'tool', tool_call_id: 'named-main', content: body }] } }, fixture.ctx);
    assert.equal((await fixture.events()).filter(event => event.phase === 'provider-request').at(-1).contents[0].sha256, hash(body));
  } finally { fixture.close(); }
});

test('a submitted name freezes its claim before Broker source work in the tool-call preamble', async () => {
  const body = 'Complete instructions from the original named source.\n', prompt = '请介绍 visible-skill。';
  const fixture = await literalObserverFixture(body, undefined, undefined, undefined, { deferred: true, prompt,
    record: { name: 'Visible Skill', alias: 'visible-skill', enabled: true, entrypoint: 'SKILL.md', ref: 'skill://shared_skill%3Acontrolled%3Aliteral-root/SKILL.md' } });
  try {
    fixture.handlers.get('before_provider_request')({ payload: fixture.payload(prompt) }, fixture.ctx);
    const input = { path: 'skill://visible-skill/SKILL.md' };
    fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'early-source-name', name: 'read', arguments: input }] } });
    const authored = (await fixture.events()).find(event => event.phase === 'authored-tool-call');
    assert.equal(authored.nameSelection?.claim.kind, 'submitted-name');
    assert.deepEqual(authored.nameSelection.claim.sourceFilesBefore, []);
    await save(path.join(fixture.responses, 'name-selection.json'), nameCatalog(fixture));
    await fixture.publish();
    assert.equal(fixture.handlers.get('tool_call')({ toolName: 'read', toolCallId: 'early-source-name', input }), undefined);
    fixture.handlers.get('tool_result')({ toolName: 'read', toolCallId: 'early-source-name', content: [{ type: 'text', text: body }] });
    const events = await fixture.events(), call = events.find(event => event.phase === 'tool-call'), read = events.find(event => event.phase === 'tool-result');
    assert.deepEqual(call.claim, authored.nameSelection.claim);
    assert.equal(call.argumentsSha256, hash(JSON.stringify(input))); assert.equal(call.authoredSequence, authored.sequence);
    assert.equal(read.complete, true); assert.equal(read.ownerId, fixture.owner); assert.equal(read.scope, fixture.scope);
    assert.equal(read.nameResolution.readRequestId, 'literal-public-read');
  } finally { fixture.close(); }
});

for (const projection of ['view', 'profile', 'query', 'page']) test('a full ordinary name selection remains valid beside a successful background ' + projection + ' projection', async () => {
  const body = 'Complete named instructions.\n', prompt = '请介绍 visible-skill。';
  const fixture = await literalObserverFixture(body, undefined, undefined, undefined, { deferred: true, prompt,
    record: { name: 'Visible Skill', alias: 'visible-skill', enabled: true, entrypoint: 'SKILL.md', ref: 'skill://shared_skill%3Acontrolled%3Aliteral-root/SKILL.md' } });
  try {
    fixture.handlers.get('before_provider_request')({ payload: fixture.payload(prompt) }, fixture.ctx);
    const input = { path: 'skill://visible-skill/SKILL.md' };
    fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'background-projection', name: 'read', arguments: input }] } });
    const projected = nameCatalog(fixture); projected.requestId = 'background-' + projection;
    if (projection === 'page') Object.assign(projected.response, { total_count: 2, has_more: true, next_cursor: 'next' });
    else projected.response[projection] = projection === 'query' ? 'visible' : { id: 'background-' + projection };
    await save(path.join(fixture.responses, 'background.json'), projected);
    await save(path.join(fixture.responses, 'ordinary.json'), nameCatalog(fixture));
    await fixture.publish();
    assert.equal(fixture.handlers.get('tool_call')({ toolName: 'read', toolCallId: 'background-projection', input }), undefined);
    fixture.handlers.get('tool_result')({ toolName: 'read', toolCallId: 'background-projection', content: [{ type: 'text', text: body }] });
    const read = (await fixture.events()).find(event => event.phase === 'tool-result');
    assert.equal(read.complete, true); assert.equal(read.nameResolution.selectionRequestId, 'new-name-selection');
    const sourceFiles = await fs.promises.readdir(fixture.responses);
    assert.equal(sourceFiles.length, 3, 'Ignoring a projected selection does not erase its actual source receipt');
  } finally { fixture.close(); }
});

test('notion_use without a received authored selection blocks explicitly', async () => {
  const fixture = await literalObserverFixture('Complete original source.\n');
  try {
    const input = { ref: 'skill://' + encodeURIComponent(fixture.owner) + '/SKILL.md' };
    assert.equal(fixture.handlers.get('tool_call')({ toolName: 'notion_use', toolCallId: 'missing-author', input }).block, true);
    assert.equal((await fixture.events()).find(event => event.phase === 'tool-call').allowed, false);
  } finally { fixture.close(); }
});

for (const variant of ['before-provider', 'assistant', 'unverified-tool', 'different-user-text', 'longer-word', 'private-source-only']) test('a submitted-name attempt rejects ' + variant + ' as literal user authority', async () => {
  const selector = 'visible-skill', prompt = variant === 'longer-word' ? '请介绍 prefix-visible-skill-suffix。'
    : variant === 'private-source-only' ? '请完成普通任务。' : '请介绍 visible-skill。';
  const fixture = await literalObserverFixture('Unseen private body.\n', undefined, undefined, undefined, { deferred: true, prompt,
    record: { name: selector, alias: selector, enabled: true, entrypoint: 'SKILL.md', ref: 'skill://shared_skill%3Acontrolled%3Aliteral-root/SKILL.md' } });
  try {
    await save(path.join(fixture.responses, 'hidden-catalog.json'), nameCatalog(fixture));
    if (variant !== 'before-provider') {
      const message = { role: variant === 'assistant' ? 'assistant' : variant === 'unverified-tool' ? 'tool' : 'user',
        content: variant === 'different-user-text' ? prompt + ' This was not the frozen request.' : prompt };
      fixture.handlers.get('before_provider_request')({ payload: { ...fixture.payload(prompt), messages: [message] } }, fixture.ctx);
    }
    const input = { path: 'skill://visible-skill/SKILL.md' };
    fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'rejected-name', name: 'read', arguments: input }] } });
    assert.equal(fixture.handlers.get('tool_call')({ toolName: 'read', toolCallId: 'rejected-name', input }).block, true);
    assert.equal((await fixture.events()).some(event => event.phase === 'tool-call' && event.allowed), false);
  } finally { fixture.close(); }
});

for (const variant of ['unresolved', 'ambiguous', 'failed-source', 'failed-list-operation', 'incomplete', 'projected', 'failed-projected-source', 'failed-projected-operation', 'duplicate-id', 'wrong-owner', 'wrong-scope', 'wrong-main', 'old-catalog', 'old-read', 'partial-body']) test('a submitted-name result cannot bind ' + variant + ' source evidence', async () => {
  const body = 'Complete introduced instructions.\n', prompt = '请介绍 visible-skill。';
  const fixture = await literalObserverFixture(body, undefined, undefined, undefined, { deferred: true, prompt,
    record: { name: 'Visible Skill', alias: 'visible-skill', enabled: true, entrypoint: 'SKILL.md', ref: 'skill://shared_skill%3Acontrolled%3Aliteral-root/SKILL.md' } });
  try {
    const catalog = nameCatalog(fixture);
    if (variant === 'old-catalog') await save(path.join(fixture.responses, 'name-selection.json'), catalog);
    if (variant === 'old-read') await fixture.publish();
    fixture.handlers.get('before_provider_request')({ payload: fixture.payload(prompt) }, fixture.ctx);
    const input = { path: 'skill://visible-skill/SKILL.md' };
    fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'named-main', name: 'read', arguments: input }] } });
    assert.equal(fixture.handlers.get('tool_call')({ toolName: 'read', toolCallId: 'named-main', input }), undefined);
    const value = catalog.response;
    if (variant === 'unresolved') { value.records = []; value.count = 0; }
    if (variant === 'ambiguous') { value.records.push({ ...fixture.record, id: 'shared_skill:controlled:other', ref: 'skill://shared_skill%3Acontrolled%3Aother/SKILL.md' }); value.count = 2; }
    if (variant === 'failed-source') value.coverage.failed_sources.push({ id: 'another-source', code: 'ACCESS_DENIED' });
    if (variant === 'incomplete') value.coverage.exhaustive = false;
    if (variant === 'projected') value.view = { id: 'a-complete-view-is-not-the-whole-source' };
    if (variant === 'duplicate-id') { value.records.push(structuredClone(fixture.record)); value.count = 2; }
    if (variant === 'wrong-owner') value.records = [{ ...fixture.record, id: 'shared_skill:controlled:other', ref: 'skill://shared_skill%3Acontrolled%3Aother/SKILL.md' }];
    if (variant === 'wrong-scope') value.scope = 'b'.repeat(64);
    if (variant === 'wrong-main') value.records = [{ ...fixture.record, entrypoint: 'WORKFLOW.md', ref: fixture.record.ref.replace('/SKILL.md', '/WORKFLOW.md') }];
    if (variant !== 'old-catalog') await save(path.join(fixture.responses, 'name-selection.json'), catalog);
    if (variant === 'failed-list-operation') await save(path.join(fixture.responses, 'failed-source.json'), { requestId: 'failed-name-source', transport: 'sdk', operation: 'list', status: 'failed', resultObserved: false, value: null });
    if (variant.startsWith('failed-projected-')) {
      const projected = nameCatalog(fixture); projected.requestId = 'failed-background'; projected.response.view = { id: 'background-view' };
      if (variant === 'failed-projected-source') projected.response.coverage.failed_sources.push({ id: 'background-source', code: 'ACCESS_DENIED' });
      else projected.code = 1;
      await save(path.join(fixture.responses, 'failed-projection.json'), projected);
    }
    if (variant !== 'old-read') await fixture.publish();
    fixture.handlers.get('tool_result')({ toolName: 'read', toolCallId: 'named-main', content: [{ type: 'text', text: variant === 'partial-body' ? body.slice(0, -3) : body }] });
    const read = (await fixture.events()).find(event => event.phase === 'tool-result' && event.toolCallId === 'named-main');
    assert.equal(read.complete, false); assert.equal(read.nameResolution, undefined);
  } finally { fixture.close(); }
});

test('the exact provided native path resolves through its verified manifest when the wrapper omits File ID', async () => {
  const body = 'Controlled complete main.\n', fixture = await literalObserverFixture(body, undefined, undefined, 'stable-main');
  const actual = path.join(fixture.root, 'SKILL.md');
  const ref = 'skill://' + encodeURIComponent(fixture.owner) + '/SKILL.md?snapshot=' + fixture.snapshot;
  const invoke = (id, value) => {
    fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: value } }] } });
    return fixture.handlers.get('tool_call')({ toolName: 'read', toolCallId: id, input: { path: value } });
  };
  try {
    fixture.handlers.get('before_provider_request')({ payload: fixture.payload(body) }, fixture.ctx);
    assert.equal(invoke('not-advertised', actual).block, true, 'body bytes alone do not advertise a local path');
    const wrapper = '<context-broker-record kind="skill" path="' + actual + '">\n<skill-ref>' + ref + '</skill-ref>\n' + body + '</context-broker-record>';
    fixture.handlers.get('before_provider_request')({ payload: fixture.payload(wrapper) }, fixture.ctx);
    assert.equal(invoke('provided-path', actual), undefined);
    assert.equal(invoke('canonical-ref', ref + '&file_id=stable-main'), undefined);
    fixture.handlers.get('tool_result')({ toolName: 'read', toolCallId: 'provided-path', content: [{ type: 'text', text: body }] });
    assert.ok((await fixture.events()).some(event => event.phase === 'tool-result' && event.toolCallId === 'provided-path' && event.complete && event.ref.endsWith('&file_id=stable-main')));
  } finally { fixture.close(); }
});

test('an exact advertised home-relative native path resolves to the same verified manifest without rewriting the tool input', async () => {
  const body = 'Controlled home-relative main.\n', fixture = await literalObserverFixture(body, undefined, undefined, 'stable-main');
  const advertised = '~/' + path.relative(fixture.directory, path.join(fixture.root, 'SKILL.md'));
  const ref = 'skill://' + encodeURIComponent(fixture.owner) + '/SKILL.md?snapshot=' + fixture.snapshot;
  try {
    const wrapper = '<context-broker-record path="' + advertised + '"><skill-ref>' + ref + '</skill-ref>\n' + body + '</context-broker-record>';
    fixture.handlers.get('before_provider_request')({ payload: fixture.payload(wrapper) }, fixture.ctx);
    fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'home-read', name: 'read', arguments: { path: advertised } }] } });
    assert.equal(fixture.handlers.get('tool_call')({ toolName: 'read', toolCallId: 'home-read', input: { path: advertised } }), undefined);
    fixture.handlers.get('tool_result')({ toolName: 'read', toolCallId: 'home-read', content: [{ type: 'text', text: body }] });
    const events = await fixture.events();
    assert.ok(events.some(event => event.phase === 'tool-call' && event.input === advertised && event.allowed));
    assert.ok(events.some(event => event.phase === 'tool-result' && event.toolCallId === 'home-read' && event.complete && event.ref.endsWith('&file_id=stable-main')));
  } finally { fixture.close(); }
});

test('provided-path observation rejects changed owner, pin, File ID, traversal and assistant-only advertisements', async () => {
  const body = 'Controlled protected main.\n', fixture = await literalObserverFixture(body, undefined, undefined, 'stable-main');
  const actual = path.join(fixture.root, 'SKILL.md');
  const ref = 'skill://' + encodeURIComponent(fixture.owner) + '/SKILL.md?snapshot=' + fixture.snapshot;
  const wrapper = (location, identity) => '<context-broker-record path="' + location + '"><skill-ref>' + identity + '</skill-ref>\n' + body + '</context-broker-record>';
  const invoke = (id, location) => {
    fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: location } }] } });
    return fixture.handlers.get('tool_call')({ toolName: 'read', toolCallId: id, input: { path: location } });
  };
  try {
    const invalid = [
      wrapper(actual, ref.replace(encodeURIComponent(fixture.owner), 'different-owner')),
      wrapper(actual, ref.replace(fixture.snapshot, 'different-snapshot')),
      wrapper(actual, ref + '&file_id=different-file'),
      wrapper(fixture.root + '/../' + path.basename(fixture.root) + '/SKILL.md', ref),
    ];
    for (const [index, content] of invalid.entries()) {
      fixture.handlers.get('before_provider_request')({ payload: fixture.payload(content) }, fixture.ctx);
      assert.equal(invoke('invalid-' + index, actual).block, true);
    }
    const payload = fixture.payload(body); payload.messages.push({ role: 'assistant', content: wrapper(actual, ref) });
    fixture.handlers.get('before_provider_request')({ payload }, fixture.ctx);
    assert.equal(invoke('assistant-only', actual).block, true);
  } finally { fixture.close(); }
});

test('large exact bodies and their HTML/JSON forms count without compiling a body-sized regular expression', async () => {
  const body = 'Literal <b>evidence & detail</b> [x](y) "quoted" \\ value.\n'.repeat(1500);
  const encoded = body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const quoted = JSON.stringify(body).slice(1, -1);
  assert.ok(body.length + encoded.length + quoted.length > 128 * 1024);
  const fixture = await literalObserverFixture(body);
  try {
    for (const value of [body, encoded, quoted, body + '\n' + encoded]) fixture.handlers.get('before_provider_request')({ payload: fixture.payload(value) }, fixture.ctx);
    const providers = (await fixture.events()).filter(event => event.phase === 'provider-request');
    assert.deepEqual(providers.map(event => event.contents.length), [1, 1, 1, 2]);
    assert.ok(providers.every(event => event.contents.every(file => file.sha256 === hash(body) && file.bytes === Buffer.byteLength(body))));
  } finally { fixture.close(); }
});

test('literal copy counting chooses the longest match at one position and excludes assistant/model quotations', async () => {
  const fixture = await literalObserverFixture('&');
  try {
    const payload = fixture.payload('&&amp;&amp;');
    payload.messages.push({ role: 'assistant', content: '&&amp;' }, { role: 'model', content: '&amp;' });
    fixture.handlers.get('before_provider_request')({ payload }, fixture.ctx);
    fixture.handlers.get('before_provider_request')({ payload: { ...payload, messages: payload.messages.slice(1) } }, fixture.ctx);
    assert.deepEqual((await fixture.events()).filter(event => event.phase === 'provider-request').map(event => event.contents.length), [3, 0]);
  } finally { fixture.close(); }
});

test('an observer fault or changed unverified payload is recorded and cannot reach the provider transport', async () => {
  let dispatched = 0;
  const fixture = await literalObserverFixture('Controlled complete body.\n', async () => { dispatched++; return new Response('{}', { status: 200 }); });
  const send = payload => globalThis.fetch('http://127.0.0.1/controlled-provider', { method: 'POST', body: JSON.stringify(payload) });
  try {
    const payload = fixture.payload('Controlled complete body.\n');
    fixture.handlers.get('before_provider_request')({ payload }, fixture.ctx);
    await send(payload);
    assert.equal(dispatched, 1);
    const invalid = { ...payload, tools: payload.tools.slice(0, 1) };
    assert.throws(() => fixture.handlers.get('before_provider_request')({ payload: invalid }, fixture.ctx), /advertise/);
    await assert.rejects(send(invalid), /unverified|observation/i);
    fixture.handlers.get('before_provider_request')({ payload }, fixture.ctx);
    await assert.rejects(send({ ...payload, messages: [] }), /unverified|observation/i);
    assert.equal(dispatched, 1);
    const events = await fixture.events();
    assert.ok(events.some(event => event.phase === 'observer-error' && event.stage === 'before_provider_request'));
    assert.equal(events.filter(event => event.phase === 'provider-transport-blocked').length, 2);
    assert.equal(events.filter(event => event.phase === 'provider-transport-start').length, 1);
  } finally { fixture.close(); }
});

test('graph evidence distinguishes observer failure from absent transport or model task failure', () => {
  const value = attributionFixture(['file-root']);
  value.observation.push({ phase: 'observer-error', stage: 'before_provider_request', code: 'GRAPH_OBSERVER_INVALID' });
  assert.throws(() => graphTrace(value), error => error.code === 'GRAPH_OBSERVER_INVALID');
  value.observation = [{ phase: 'provider-transport-start' }, { phase: 'provider-transport-response', status: 200 }];
  assert.throws(() => graphTrace(value), error => error.code === 'GRAPH_OBSERVER_INVALID' && /transport/.test(error.message));
});

test('the frozen legacy read-only surface retains provider proof and transitions explicitly to the public tools', async () => {
  let dispatched = 0;
  const fixture = await literalObserverFixture('Controlled complete body.\n', async () => { dispatched++; return new Response('{}', { status: 200 }); }, 'native-read-only');
  try {
    const payload = fixture.payload('Controlled complete body.\n'), readOnly = { ...payload, tools: payload.tools.slice(0, 1) };
    fixture.handlers.get('before_provider_request')({ payload: readOnly }, fixture.ctx);
    await globalThis.fetch('http://127.0.0.1/controlled-provider', { method: 'POST', body: JSON.stringify(readOnly) });
    fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'unadvertised-search', name: 'skill_search', arguments: { query: '' } }] } });
    assert.equal(fixture.handlers.get('tool_call')({ toolName: 'skill_search', toolCallId: 'unadvertised-search', input: { query: '' } }).block, true);
    await save(fixture.toolSurfaceFile, { surface: 'public-tools' });
    fixture.handlers.get('before_provider_request')({ payload }, fixture.ctx);
    await globalThis.fetch('http://127.0.0.1/controlled-provider', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(dispatched, 2);
    const proofs = (await fixture.events()).filter(event => event.phase === 'provider-request');
    assert.deepEqual(proofs.map(event => [event.toolSurface, event.tools, event.contents.length]), [['native-read-only', ['read'], 1], ['public-tools', [...GRAPH_GATE_TOOLS].sort(), 1]]);
    assert.throws(() => fixture.handlers.get('before_provider_request')({ payload: readOnly }, fixture.ctx), /frozen native tool surface/);
    await save(fixture.toolSurfaceFile, { surface: 'unrecognized' });
    assert.throws(() => fixture.handlers.get('before_provider_request')({ payload }, fixture.ctx), /Unknown frozen graph tool surface/);
  } finally { fixture.close(); }
});

test('owned fallback traps record PATH login and the old override without changing the parent environment', async () => {
  const base = await mkdtemp(path.join(await systemTempRoot(), 'graph-no-ntn-'));
  const originalPath = process.env.PATH, originalOverride = process.env.NTN_SKILLS_NTN_BIN;
  const traps = await createGraphFallbackTraps(path.join(base, 'control'), base);
  const env = { ...process.env, ...traps.environment };
  assert.equal(spawnSync('ntn', ['login'], { env, encoding: 'utf8' }).status, 97);
  assert.equal(spawnSync(env.NTN_SKILLS_NTN_BIN, ['doctor'], { env, encoding: 'utf8' }).status, 97);
  const recorded = (await readFile(traps.ledger, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(recorded.map(event => [event.executable, event.operation]), [['ntn', 'login'], ['legacy-ntn', 'doctor']]);
  assert.equal(process.env.PATH, originalPath); assert.equal(process.env.NTN_SKILLS_NTN_BIN, originalOverride);
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

test('matrix status retains a final run failure even when all five graph samples passed', () => {
  const passed = {
    runs: [{ status: 'passed' }, { status: 'passed' }, { status: 'passed' }],
    samples: ['cold', 'warm-new-process', 'warm-new-process', 'continued-session', 'continued-session'].map(mode => ({ mode, status: 'passed' })),
  };
  assert.equal(graphModel.matrixStatus(passed), 'passed');
  const failedRun = structuredClone(passed);
  failedRun.runs[2] = { status: 'failed', error: { code: 'ERR_ASSERTION', message: 'A post-sample read boundary failed' } };
  const before = JSON.stringify(failedRun);
  assert.equal(graphModel.matrixStatus(failedRun), 'failed');
  assert.equal(JSON.stringify(failedRun), before, 'Graph samples and the run failure remain unchanged');
  const failedSample = structuredClone(passed); failedSample.samples[4].status = 'failed';
  assert.equal(graphModel.matrixStatus(failedSample), 'failed');
  assert.equal(graphModel.matrixStatus({ ...passed, samples: passed.samples.slice(0, 4) }), 'failed');
  assert.equal(graphModel.matrixStatus({ ...passed, runs: passed.runs.slice(0, 2) }), 'failed');
});

async function addLiteralResource(fixture, relative, content) {
  const actual = path.join(fixture.root, relative);
  await mkdir(path.dirname(actual), { recursive: true }); await writeFile(actual, content);
  const manifestPath = path.join(fixture.root, '.broker-snapshot.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files.push({ path: relative, bytes: Buffer.byteLength(content), hash: hash(content) });
  await save(manifestPath, manifest);
  return actual;
}

function authoredRead(fixture, id, input) {
  fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: input } }] } });
  return fixture.handlers.get('tool_call')({ toolName: 'read', toolCallId: id, input: { path: input } });
}

for (const format of ['html', 'native-wrapper', 'escaped-html', 'markdown']) {
  test('verified resource discovery admits the explicit ' + format + ' path without loading other manifest files', async () => {
    const relative = 'playbooks/authoring-a-skill.md', content = 'Controlled resource body.\n';
    const annotation = format === 'escaped-html' ? '&lt;code&gt;' + relative + '&lt;/code&gt;'
      : format === 'markdown' ? '[Authoring](' + relative + ')' : '<code>' + relative + '</code>';
    const body = 'Controlled complete main.\nFile: ' + annotation + '.\n';
    const fixture = await literalObserverFixture(body);
    try {
      const actual = await addLiteralResource(fixture, relative, content);
      const hidden = await addLiteralResource(fixture, 'playbooks/unmentioned.md', 'Unmentioned resource.\n');
      const encoded = body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const supplied = format === 'native-wrapper'
        ? '<context-broker-record path="' + path.join(fixture.root, 'SKILL.md') + '"><skill-ref>skill://' + encodeURIComponent(fixture.owner) + '/SKILL.md?snapshot=' + fixture.snapshot + '</skill-ref>\n' + encoded + '</context-broker-record>'
        : body;
      fixture.handlers.get('before_provider_request')({ payload: fixture.payload(supplied) }, fixture.ctx);
      assert.equal(authoredRead(fixture, 'explicit-resource', actual), undefined);
      fixture.handlers.get('tool_result')({ toolName: 'read', toolCallId: 'explicit-resource', content: [{ type: 'text', text: content }], isError: false });
      const event = (await fixture.events()).find(event => event.phase === 'tool-result' && event.toolCallId === 'explicit-resource');
      assert.equal(event.complete, true);
      assert.equal(event.scope, fixture.scope); assert.equal(event.ownerId, fixture.owner);
      assert.equal(event.snapshot, fixture.snapshot); assert.equal(event.path, relative);
      assert.equal(event.logicalId, fixture.owner + '/' + relative, 'Historical manifest resources keep their existing owner/path identity');
      assert.equal(event.sha256, hash(content)); assert.equal(event.bytes, Buffer.byteLength(content));
      assert.equal(authoredRead(fixture, 'unmentioned-resource', hidden).block, true);
    } finally { fixture.close(); }
  });
}

test('HTML path text cannot authorize reads through partial bodies, unrelated context or assistant quotations', async () => {
  const relative = 'playbooks/authoring-a-skill.md', annotated = 'Controlled complete main.\nFile: <code>' + relative + '</code>.\n';
  for (const mode of ['partial', 'unrelated-context', 'assistant-only']) {
    const body = mode === 'unrelated-context' ? 'Controlled complete main without a resource reference.\n' : annotated;
    const fixture = await literalObserverFixture(body);
    try {
      const actual = await addLiteralResource(fixture, relative, 'Controlled resource.\n');
      const payload = fixture.payload(mode === 'partial' ? body.slice(0, -2) : mode === 'unrelated-context' ? body + '\n' + annotated : 'No verified source body here.');
      if (mode === 'assistant-only') payload.messages.push({ role: 'assistant', content: body });
      fixture.handlers.get('before_provider_request')({ payload }, fixture.ctx);
      assert.equal(authoredRead(fixture, mode, actual).block, true);
    } finally { fixture.close(); }
  }
});

test('HTML resource discovery stays within the current scope owner snapshot and relative path', async () => {
  const relative = 'playbooks/authoring-a-skill.md';
  for (const changed of ['owner', 'scope', 'snapshot', 'traversal', 'absolute']) {
    const annotation = changed === 'traversal' ? '../../' + relative : changed === 'absolute' ? '/' + relative : relative;
    const body = 'Controlled complete main.\nFile: <code>' + annotation + '</code>.\n';
    const fixture = await literalObserverFixture(body);
    try {
      let actual;
      if (['traversal', 'absolute'].includes(changed)) actual = await addLiteralResource(fixture, relative, 'Controlled resource.\n');
      else {
        const owner = changed === 'owner' ? fixture.owner + ':other' : fixture.owner;
        const scope = changed === 'scope' ? 'b'.repeat(64) : fixture.scope;
        const snapshot = changed === 'snapshot' ? 's_' + hash('different snapshot') : fixture.snapshot;
        const otherRoot = path.join(fixture.directory, 'cache', 'scopes', scope, 'records', hash(owner), 'snapshots', snapshot);
        const main = 'A different unprovided main.\n', content = 'Different resource.\n';
        actual = path.join(otherRoot, relative);
        await mkdir(path.dirname(actual), { recursive: true }); await writeFile(actual, content);
        await writeFile(path.join(otherRoot, 'SKILL.md'), main);
        await save(path.join(otherRoot, '.broker-snapshot.json'), { version: 3, projection: 'snapshot', scope, snapshot, entry: 'SKILL.md', record: { id: owner, kind: 'skill' },
          files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(main), hash: hash(main) }, { path: relative, bytes: Buffer.byteLength(content), hash: hash(content) }] });
        await save(path.join(fixture.directory, 'responses', 'other-read.json'), { command: 'read', code: 0, response: { ok: true, scope, snapshot_id: snapshot, version_id: hash(main), path: 'SKILL.md', record: { id: owner, kind: 'skill' }, content: main } });
      }
      fixture.handlers.get('before_provider_request')({ payload: fixture.payload(body) }, fixture.ctx);
      assert.equal(authoredRead(fixture, changed, actual).block, true);
    } finally { fixture.close(); }
  }
});

test('HTML discovery preserves the immutable resource byte and symlink guards', async () => {
  for (const changed of ['bytes', 'symlink']) {
    const body = 'Controlled main.\nFile: <code>references/guide.md</code>.\n';
    const fixture = await literalObserverFixture(body);
    try {
      const actual = await addLiteralResource(fixture, 'references/guide.md', 'Original resource.\n');
      if (changed === 'bytes') await writeFile(actual, 'Changed resource.\n');
      else {
        const outside = path.join(fixture.directory, 'outside.md'); await writeFile(outside, 'Original resource.\n');
        fs.unlinkSync(actual); await symlink(outside, actual);
      }
      assert.throws(() => fixture.handlers.get('before_provider_request')({ payload: fixture.payload(body) }, fixture.ctx),
        /Snapshot resource bytes differ|Snapshot resource is not a verified regular file/);
      assert.equal((await fixture.events()).filter(event => event.phase === 'tool-call' && event.allowed).length, 0);
    } finally { fixture.close(); }
  }
});


async function partialReadFixture() {
  const relative = 'references/guide.md', body = 'Controlled main.\n[Guide](' + relative + ')\n';
  const resource = 'First line.\nSecond line.\nThird line.\nFourth line.\nFifth line.\n';
  const fixture = await literalObserverFixture(body);
  const actual = await addLiteralResource(fixture, relative, resource);
  fixture.handlers.get('before_provider_request')({ payload: fixture.payload(body) }, fixture.ctx);
  const author = (id, args) => {
    fixture.handlers.get('message_end')({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: args }] } });
    return fixture.handlers.get('tool_call')({ toolName: 'read', toolCallId: id, input: args });
  };
  const result = (id, content, isError = false) => fixture.handlers.get('tool_result')({ toolName: 'read', toolCallId: id, content: [{ type: 'text', text: content }], isError });
  return { ...fixture, relative, body, resource, actual, author, result };
}

test('a complete native resource read followed by an exact authored page keeps both observations without inventing an error', async () => {
  const f = await partialReadFixture();
  try {
    assert.equal(f.author('full-resource', { path: f.actual }), undefined); f.result('full-resource', f.resource);
    const page = 'First line.\nSecond line.\n\n[4 more lines in file. Use offset=3 to continue.]';
    assert.equal(f.author('partial-resource', { path: f.actual, offset: 1, limit: 2 }), undefined); f.result('partial-resource', page);
    const events = await f.events(), full = events.find(e => e.phase === 'tool-result' && e.toolCallId === 'full-resource');
    const partial = events.find(e => e.phase === 'tool-result' && e.toolCallId === 'partial-resource');
    assert.equal(full.complete, true); assert.equal(full.error, null);
    assert.equal(partial.complete, false); assert.equal(partial.error, null);
    assert.equal(partial.ref, undefined, 'A page cannot stand in for a complete immutable body receipt');
    assert.equal(partial.content, undefined);
    assert.deepEqual(partial.partialRead.source, { ref: full.ref, scope: f.scope, ownerId: f.owner, path: f.relative,
      snapshot: f.snapshot, sha256: hash(f.resource), bytes: Buffer.byteLength(f.resource) });
    assert.equal(partial.partialRead.offset, 1); assert.equal(partial.partialRead.limit, 2);
    assert.equal(partial.partialRead.sliceSha256, hash('First line.\nSecond line.'));
    const payload = f.payload(f.body); payload.messages.push({ role: 'tool', tool_call_id: 'full-resource', content: f.resource },
      { role: 'tool', tool_call_id: 'partial-resource', content: page });
    f.handlers.get('before_provider_request')({ payload }, f.ctx);
    const provider = (await f.events()).filter(e => e.phase === 'provider-request').at(-1);
    assert.equal(provider.contents.filter(e => e.ref === full.ref).length, 1);
    const deliveredPage = provider.toolResults.find(e => e.toolCallId === 'partial-resource');
    assert.equal(deliveredPage.sha256, hash(page)); assert.equal(deliveredPage.exactToolOutputCopies, 1);
    assert.deepEqual(deliveredPage.records, []);
  } finally { f.close(); }
});

test('verified pages before any complete read remain partial, including an exact final page without a footer', async () => {
  const f = await partialReadFixture();
  try {
    const first = 'First line.\nSecond line.\n\n[4 more lines in file. Use offset=3 to continue.]';
    assert.equal(f.author('first-page', { path: f.actual, limit: 2 }), undefined); f.result('first-page', first);
    assert.equal(f.author('final-page', { path: f.actual, offset: 5, limit: 2 }), undefined); f.result('final-page', 'Fifth line.\n');
    const results = (await f.events()).filter(e => e.phase === 'tool-result');
    assert.equal(results.length, 2);
    for (const result of results) { assert.equal(result.complete, false); assert.equal(result.error, null); assert.equal(result.ref, undefined); }
    assert.equal(results[1].partialRead.footer, '');
    assert.equal(results[1].partialRead.startLine, 5);
    assert.equal(results[1].partialRead.endLine, 6);
  } finally { f.close(); }
});

test('native errors, incorrect page bytes or footer, and a page that differs from the authored range remain read failures', async () => {
  const f = await partialReadFixture();
  try {
    const page = 'First line.\nSecond line.\n\n[4 more lines in file. Use offset=3 to continue.]';
    const cases = [
      { name: 'native-error', args: { offset: 1, limit: 2 }, content: page, isError: true },
      { name: 'wrong-slice', args: { offset: 1, limit: 2 }, content: page.replace('First', 'Other') },
      { name: 'wrong-footer', args: { offset: 1, limit: 2 }, content: page.replace('4 more', '3 more') },
      { name: 'wrong-offset', args: { offset: 2, limit: 2 }, content: page },
      { name: 'wrong-limit', args: { offset: 1, limit: 3 }, content: page },
      { name: 'unrequested-page', args: {}, content: page },
      { name: 'negative-offset', args: { offset: -1, limit: 2 }, content: page },
      { name: 'fractional-limit', args: { offset: 1, limit: 2.5 }, content: page },
      { name: 'out-of-range', args: { offset: 100, limit: 2 }, content: page },
    ];
    for (const value of cases) {
      assert.equal(f.author(value.name, { path: f.actual, ...value.args }), undefined);
      f.result(value.name, value.content, value.isError ?? false);
    }
    for (const event of (await f.events()).filter(e => e.phase === 'tool-result')) {
      assert.equal(event.complete, false); assert.match(event.error, /did not match one complete immutable file/);
      assert.equal(event.partialRead, undefined);
    }
  } finally { f.close(); }
});

test('a successful page cannot cross an immutable file identity changed after admission', async () => {
  const f = await partialReadFixture();
  try {
    const responsePath = path.join(f.directory, 'responses', 'read.json');
    const receipt = JSON.parse(await readFile(responsePath, 'utf8'));
    receipt.response.file_bindings = [{ file_id: 'file-one', page_id: uuid, path: f.relative }]; await save(responsePath, receipt);
    assert.equal(f.author('changed-identity', { path: f.actual, offset: 1, limit: 2 }), undefined);
    receipt.response.file_bindings[0].file_id = 'file-two'; await save(responsePath, receipt);
    f.result('changed-identity', 'First line.\nSecond line.\n\n[4 more lines in file. Use offset=3 to continue.]');
    const result = (await f.events()).find(e => e.phase === 'tool-result');
    assert.equal(result.complete, false); assert.match(result.error, /did not match one complete immutable file/);
    assert.equal(result.partialRead, undefined);
  } finally { f.close(); }
});
