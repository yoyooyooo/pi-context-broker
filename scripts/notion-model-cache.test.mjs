import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtemp, readFile, realpath, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verificationCliEnvironment } from './verification-paths.mjs';
import { invokeJson } from './verification-command.mjs';
import { assertModelCase, requestCounts, cacheCaseDirectory, modelAvailabilityFailure } from './verify-pi-notion-model-cache.mjs';
import { observe } from './notion-integration-model.mjs';
import { createPiHelpBoundary } from './notion-pi-help.mjs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

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
