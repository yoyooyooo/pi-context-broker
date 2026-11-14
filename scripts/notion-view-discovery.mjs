import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isolatedEnv } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { database, firstViewId, secondViewId, unflaggedAlias, unflaggedCanary, missingCanary, missingRef } from './notion-integration-fixture.mjs';
import { catalogCards, nativeEntries, verifyPreparedProviderBody, providerSystemText } from './notion-default-context.mjs';
import { decodeCatalogText } from './notion-integration-hosts.mjs';

const save = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
async function rows(path) { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
function system(context) {
  return [Array.isArray(context.systemPrompt) ? context.systemPrompt.join('\n') : context.systemPrompt ?? '', providerSystemText(context)].filter(Boolean).join('\n');
}
function current(context) {
  const text = system(context);
  const matches = [...text.matchAll(/<ntn-skills-view-catalog>[\s\S]*?<\/ntn-skills-view-catalog>/g)];
  assert.equal(matches.length, 1, 'Exactly one current View directory in the model prompt');
  return matches[0][0];
}
const occurrences = (value, needle) => JSON.stringify(value).split(needle).length - 1;

function retainedBranch(entries) {
  const indexed = entries.filter(entry => typeof entry.id === 'string'), byId = new Map(indexed.map(entry => [entry.id, entry]));
  const branch = [], seen = new Set();
  let current = indexed.at(-1);
  while (current) {
    assert.ok(!seen.has(current.id), 'Native branch must not contain a cycle');
    seen.add(current.id); branch.unshift(current);
    if (!current.parentId) break;
    current = byId.get(current.parentId); assert.ok(current, 'Native branch parent must be retained');
  }
  return branch;
}

/** Inspect the retained native branch, not every historical entry in the file. */
export function confirmedViewActivation(entries, expected) {
  const branch = retainedBranch(entries);
  const receipts = branch.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-active-sources');
  const receipt = receipts.at(-1); assert.ok(receipt, 'A successful provider delivery must have an active-source confirmation');
  assert.equal(receipt.data.sources?.length, 1);
  const source = receipt.data.sources[0];
  assert.equal(source.record.source, 'notion'); assert.equal(source.record.sourceId, 'notion');
  assert.equal(source.record.id, expected.id); assert.equal(source.record.sourceScope, expected.scope);
  for (const key of ['snapshotId', 'bodySha256', 'bytes']) assert.equal(source[key], expected[key], `Confirmed ${key} must match the exact frozen source`);
  assert.equal(source.record.body, undefined, 'Confirmation metadata is not the delivered body');
  assert.equal(receipt.data.graphs?.length, 1);
  const graph = receipt.data.graphs[0];
  assert.equal(graph.purpose, 'use'); assert.equal(graph.scope, expected.scope);
  assert.deepEqual(graph.roots, [expected.id]); assert.deepEqual(graph.required, []); assert.equal(graph.bindings.length, 1);
  const binding = graph.bindings[0];
  assert.equal(binding.record.id, expected.id); assert.equal(binding.scope, expected.scope);
  assert.equal(binding.snapshot_id, expected.snapshotId); assert.equal(binding.body_sha256, expected.bodySha256);
  assert.deepEqual(source.record.preparationBinding, binding);
  return { entryId: receipt.id, activationId: receipt.data.activation_id, graph, source,
    selectedGraphEntries: branch.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-selected-graph').map(entry => ({ id: entry.id, data: entry.data })) };
}

/** Match a nonempty partial wire response to the actual system directory. */
export function verifyPartialViewCoverage({ host, context, response, entries, fixture }) {
  assert.equal(response.ok, true); assert.equal(response.scope, fixture.scope);
  assert.equal(response.view.id, firstViewId); assert.equal(response.view.database_id, database);
  assert.equal(response.count, 1);
  assert.deepEqual(response.records.map(record => record.ref), [fixture.skillRef]);
  assert.equal(response.coverage.method, 'explicit_view'); assert.equal(response.coverage.exhaustive, false);
  assert.deepEqual(response.coverage.failed_sources, [{ id: missingRef.split('/')[2], code: 'NOT_FOUND' }]);
  const record = response.records[0], directory = current(context);
  assert.equal(record.name, fixture.name); assert.equal(record.alias, fixture.alias);
  assert.equal(record.id, 'notion_page:' + record.locator.page_id);
  const owner = 'skill://' + record.locator.page_id;
  assert.equal(record.ref, owner + '/' + record.entrypoint);
  const views = [...directory.matchAll(/<view\b([^>]*)>/gu)];
  assert.equal(views.length, 1);
  const attributes = Object.fromEntries([...views[0][1].matchAll(/([a-z_]+)="([^"]*)"/gu)].map(match => [match[1], decodeCatalogText(match[2])]));
  assert.deepEqual(attributes, { source: 'notion', id: firstViewId, database, origin: 'first', partial: 'true' });
  const cards = catalogCards(directory).filter(card => card.kind === 'skill');
  assert.equal(cards.length, 1, 'Partial coverage must preserve the exact returned member, not all-library or empty fallback');
  assert.equal(catalogCards(directory).some(card => card.kind === 'router'), false, 'An unrelated Router cannot enter the selected View');
  const card = cards[0];
  assert.equal(card.name, host === 'pi' ? record.name : 'notion-' + record.alias);
  assert.equal(card.description, record.description);
  const ref = card.location; assert.ok(ref);
  const branch = retainedBranch(entries);
  assert.equal(branch.filter(entry => ['context-broker-selected-graph', 'context-broker-active-sources'].includes(entry.customType)).length, 0, 'Metadata cannot activate or confirm a Skill');
  if (host === 'pi') {
    assert.equal(card.source, 'notion');
    if (ref.startsWith('sr:')) {
      assert.match(ref, /^sr:C[A-Za-z0-9_-]{22}$/u);
      const bindings = branch.filter(entry => entry.type === 'custom' && entry.customType === 'context-broker-short-ref' && entry.data?.ref === ref);
      assert.ok(bindings.length > 0, 'An advertised short ref needs a retained current-branch owner binding');
      const expected = { kind: 'candidate', identity: { source: 'notion', scope: response.scope, id: record.id, kind: record.kind, locator: record.locator, ref: owner } };
      for (const binding of bindings) { assert.equal(binding.data.version, 1); assert.deepEqual(binding.data.target, expected); }
    } else assert.equal(ref, record.ref, 'A canonical entry must retain the exact source owner and main path');
  } else assert.equal(card.ref, record.ref, 'The OMP native path must advertise the same canonical owner');
  for (const marker of [fixture.marker ?? fixture.canary, unflaggedCanary, missingCanary, fixture.resourceCanary, 'LOCAL_BODY_NOT_AUTOMATIC_413']) {
    assert.ok(typeof marker === 'string' && marker.length > 0);
    assert.equal(occurrences(context, marker), 0, 'Partial metadata must not contain any Skill or resource body');
  }
  return { source: 'notion', viewId: firstViewId, partial: true, count: 1, coverage: response.coverage,
    record: { id: record.id, scope: response.scope, name: record.name, description: record.description, canonicalRef: record.ref, advertisedRef: ref },
    responseSha256: createHash('sha256').update(JSON.stringify(response)).digest('hex'), directorySha256: createHash('sha256').update(directory).digest('hex') };
}

// Real installed Pi/OMP + public extension hooks + provider payload capture.
// Only the Notion CLI and LLM are controlled fixtures; no private host state setter.
export async function runViewDiscovery({ host, scratch, evidence, fixture, extension, scriptedProvider }) {
  const base = join(scratch, `${host}-view-discovery`);
  const agentDir = join(base, 'agent');
  const providerFile = join(evidence, `${host}-view-provider.jsonl`);
  const resultFile = join(evidence, `${host}-view-result.json`);
  const rpcFile = join(evidence, `${host}-view-rpc.json`);
  await mkdir(join(agentDir, 'context-broker'), { recursive: true });
  await mkdir(join(base, 'sessions'), { recursive: true });
  const compaction = { enabled: false, keepRecentTokens: 1024, reserveTokens: 4096 };
  await writeFile(join(agentDir, host === 'omp' ? 'config.yml' : 'settings.json'), host === 'omp'
    ? 'startup:\n  setupWizard: false\n  checkUpdate: false\ncompaction:\n  enabled: false\n  keepRecentTokens: 1024\n  reserveTokens: 4096\n  methodOrder: [soft]\n'
    : JSON.stringify({ enableSkillCommands: true, compaction }));
  await mkdir(join(agentDir, 'skills', 'local-keeper'), { recursive: true });
  await writeFile(join(agentDir, 'skills', 'local-keeper', 'SKILL.md'), '---\nname: local-keeper\ndescription: LOCAL_METADATA_KEPT_413\n---\nLOCAL_BODY_NOT_AUTOMATIC_413\n');
  const configPath = join(agentDir, 'context-broker', 'config.yml');
  const source = { type: 'notion', id: 'notion', namespace: 'notion', command: fixture.command, database, cacheDir: join(base, 'source-cache') };
  await save(configPath, { sources: [source] });
  await fixture.setScenario('normal', { includeUnflagged: true });
  const provider = await scriptedProvider(base);
  const toolPlan = join(base, 'tool-plan.json');
  await save(toolPlan, { trigger: 'NEVER', id: 'view-resource', path: '/nonexistent' });
  const compactionMode = join(base, 'compaction-mode.txt');
  await writeFile(compactionMode, 'remove');
  const env = isolatedEnv({ base, agentDir, CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile, BROKER_NOTION_TOOL_PLAN: toolPlan, CONTEXT_BROKER_E2E_COMPACTION_MODE_FILE: compactionMode });
  const lifecycle = join(import.meta.dirname, '../packages/context-broker/scripts/context-broker-lifecycle-fixture.mjs');
  const args = ['--no-extensions', '--session-dir', join(base, 'sessions'), '--tools', 'read', '-e', provider, '-e', extension, '-e', lifecycle, '--model', 'context-broker-e2e/fake', ...(host === 'omp' ? ['--no-title', '--no-rules'] : [])];
  const result = { host, mode: 'view-discovery', status: 'running', observations: [], files: [`${host}-view-provider.jsonl`, `${host}-view-result.json`, `${host}-view-rpc.json`], notRun: ['real LLM', 'Tern GUI'] };
  const captures = () => rows(providerFile);
  const names = host === 'pi' ? { alpha: fixture.name, beta: 'UI Beta' } : { alpha: `notion-${fixture.alias}`, beta: `notion-${unflaggedAlias}` };
  const listed = (context, name) => nativeEntries(host, context).filter(entry => entry.name === name && (host !== 'pi' || entry.source === 'notion'));
  let rpc;
  const allFrames = [];
  const ready = async (active = rpc) => {
    const before = (await captures()).length;
    await active.prompt('/context-broker refresh');
    assert.equal((await captures()).length, before, 'The explicit metadata readiness barrier must not call the provider');
  };
  const boot = async () => { rpc = await startRpc({ host, cwd: base, args, env }); await ready(); };
  const stop = async () => { if (rpc) { const active = rpc; rpc = undefined; try { await active.stop(); } finally { allFrames.push(...active.frames); } } };
  const metadata = async (expected, absent, message = 'Describe available workflow names without reading any files.') => {
    await rpc.prompt(message);
    const context = (await captures()).at(-1).context;
    const directory = current(context);
    assert.ok(directory.includes(expected), 'Selected View metadata must be in next request');
    if (absent) assert.ok(!directory.includes(absent), 'Old View metadata must leave the next request');
    assert.ok(system(context).includes('LOCAL_METADATA_KEPT_413'), 'Unmanaged local Skill metadata is preserved');
    return context;
  };
  const command = async text => {
    const before = (await captures()).length;
    await rpc.prompt(text);
    assert.equal((await captures()).length, before, 'View management must not call the model');
  };
  const retainSession = async name => {
    const state = await rpc.command('get_state'); assert.ok(state.sessionFile);
    const text = await readFile(state.sessionFile, 'utf8'), file = `${host}-view-${name}-session.jsonl`;
    await writeFile(join(evidence, file), text, { mode: 0o600 }); result.files.push(file);
    return text.trim().split('\n').map(JSON.parse);
  };
  try {
    await boot();
    await command('/context-broker view');
    await command('/context-broker views');
    const viewCalls = (await rows(fixture.callsPath)).filter(call => call.command === 'views' || call.command === 'ctl' && call.args[0] === 'views');
    assert.ok(viewCalls.length, 'The actual management entry must query available Views');
    assert.ok(viewCalls.every(call => call.command === 'ctl' && call.args[0] === 'views'), 'Current internal View callers must use ctl views; the fixture alias alone is not migration evidence');
    result.observations.push({ action: 'actual View metadata query', command: 'ctl', args: viewCalls.at(-1).args, providerRequests: 0, readiness: 'explicit public refresh before assertions; startup pending is allowed' });
    assert.equal((await captures()).length, 0, 'No model request before first user message');
    const before = (await rpc.command('get_messages')).messages;
    assert.equal(occurrences(before, 'ntn-skills-view-catalog'), 0, 'Startup must not persist a directory message');
    assert.equal(occurrences(before, fixture.marker), 0, 'Startup must not activate prepared bodies');
    let context = await metadata(firstViewId, secondViewId);
    assert.ok(listed(context, names.alpha).length);
    assert.equal(listed(context, names.beta).length, 0);
    assert.equal(occurrences(context, fixture.marker), 0);
    assert.equal(occurrences(context, unflaggedCanary), 0);
    result.observations.push('first actual request contains metadata only; startup and view commands make zero provider calls');

    const points = await rpc.command(host === 'pi' ? 'get_fork_messages' : 'get_branch_messages');
    const forkPoint = points.messages?.at(-1)?.entryId;
    assert.ok(forkPoint);
    await command(`/context-broker view ${secondViewId}`);
    context = await metadata(secondViewId, firstViewId);
    assert.ok(listed(context, names.beta).length, 'Unchecked Skill belongs to selected View');
    assert.equal(listed(context, names.alpha).length, 0);
    result.observations.push('switch replaces metadata on next request; unchecked record is eligible by View');

    await rpc.prompt(`$${fixture.alias}@notion Apply this outside-View workflow.`);
    context = (await captures()).at(-1).context;
    assert.equal(occurrences(context.messages, fixture.marker), 1, 'Explicit out-of-View choice remains usable');
    await command(`/context-broker view ${firstViewId}`);
    context = await metadata(firstViewId, secondViewId);
    assert.equal(occurrences(context.messages, fixture.marker), 1, 'Switch does not withdraw or duplicate loaded body');
    await command(`/context-broker view ${secondViewId}`);
    context = await metadata(secondViewId, firstViewId);
    assert.equal(occurrences(context.messages, fixture.marker), 1);
    result.observations.push('out-of-View explicit activation and pinned body survive repeated switches without duplicate injection');

    await command('/context-broker view 99999999-9999-4999-8999-999999999999');
    context = await metadata(secondViewId, firstViewId);
    assert.ok(rpc.frames.some(frame => JSON.stringify(frame).includes('NOT_FOUND')), 'Invalid selection is visible');
    const saved = (await rpc.command('get_state')).sessionFile;
    assert.ok(saved);
    await stop();
    rpc = await startRpc({ host, cwd: base, args: [...args, '--session', saved], env });
    await ready();
    context = await metadata(secondViewId, firstViewId);
    assert.equal(occurrences(context.messages, fixture.marker), 1);
    result.observations.push('invalid View does not change working selection; process resume restores persisted session choice');

    const fork = await rpc.command(host === 'pi' ? 'fork' : 'branch', { entryId: forkPoint });
    assert.notEqual(fork.cancelled, true);
    await ready();
    context = await metadata(firstViewId, secondViewId);
    assert.equal(occurrences(context.messages, fixture.marker), 0, 'Branch before selection also precedes body loading');
    result.observations.push('rewind/fork restores the choice from active-branch entries');

    await stop();
    await boot();
    const beforeEarlySwitch = (await captures()).length;
    await command(`/context-broker view ${secondViewId}`);
    assert.equal((await captures()).length, beforeEarlySwitch);
    context = await metadata(secondViewId, firstViewId);
    result.observations.push('selecting a View before the first user message affects that very first model request');
    const sibling = await startRpc({ host, cwd: base, args, env });
    try {
      await ready(sibling);
      await sibling.prompt('List the default workflow metadata without opening files.');
      const siblingContext = (await captures()).at(-1).context;
      assert.ok(current(siblingContext).includes(firstViewId));
      assert.ok(!current(siblingContext).includes(secondViewId));
      await metadata(secondViewId, firstViewId);
      result.observations.push('two live sessions sharing one profile keep independent View selections');
    } finally { await sibling.stop(); allFrames.push(...sibling.frames); }

    await rpc.prompt(`$${fixture.alias}@notion Inspect this workflow before the compression test.`);
    let expected, confirmed;
    if (host === 'pi') {
      // Oracle reads the already selected controlled source receipt; it never
      // inserts expected text into a provider prompt or prewarms the consumer.
      const frozen = JSON.parse(await readFile(join(fixture.statePath + '.snapshots', fixture.snapshotId + '.json'), 'utf8'));
      expected = { id: frozen.skill.id, scope: fixture.scope, snapshotId: fixture.snapshotId,
        bytes: Buffer.byteLength(frozen.content), bodySha256: createHash('sha256').update(frozen.content).digest('hex') };
      verifyPreparedProviderBody((await captures()).at(-1).context, fixture.name, expected);
      confirmed = confirmedViewActivation(await retainSession('before-compact'), expected);
    }
    await rpc.prompt('Ordinary unrelated conversation filler. '.repeat(1800));
    const compacted = await rpc.command('compact', { customInstructions: 'Summarize ordinary conversation; do not retain skill bodies.' });
    assert.notEqual(compacted.cancelled, true);
    assert.equal(occurrences((await rpc.command('get_messages')).messages, fixture.marker), 0, 'Compaction must first remove the actual body before restoration can be claimed');
    if (host === 'pi') assert.deepEqual(confirmedViewActivation(await retainSession('compacted'), expected), confirmed, 'Compaction must retain the same confirmed vector');
    const restoreStart = (await rows(fixture.callsPath)).length;
    context = await metadata(secondViewId, firstViewId);
    if (host === 'pi') {
      // AH-627 / agent-cli-ref-20261105: an active, actually delivered Skill is
      // restored on an ordinary turn after compaction, at its confirmed pin.
      assert.equal(occurrences(context.messages, fixture.marker), 1);
      verifyPreparedProviderBody(context, fixture.name, expected);
      const fixedRef = `${fixture.skillRef}?snapshot=${expected.snapshotId}`;
      assert.ok(JSON.stringify(context.messages).includes(fixedRef), 'Restoration must advertise the original fixed owner and snapshot');
      const calls = (await rows(fixture.callsPath)).slice(restoreStart).filter(call => (call.operation ?? call.command) === 'prepare');
      assert.equal(calls.length, 1, 'One fixed inspect restores the missing active root');
      assert.equal(calls[0].args[0], fixedRef);
      assert.equal(calls[0].args[calls[0].args.indexOf('--purpose') + 1], 'inspect');
      assert.ok(calls[0].args.includes('--session-bindings'));
      assert.deepEqual(confirmedViewActivation(await retainSession('restored'), expected), confirmed, 'Inspect restoration cannot install a new use selection or confirmation');
      result.observations.push({ action: 'ordinary turn restores confirmed active body after compaction', contract: 'AH-627 agent-cli-ref-20261105',
        beforeRestoreBodies: 0, providerBodies: 1, fixedRef, bytes: expected.bytes, sha256: expected.bodySha256, activationId: confirmed.activationId, inspectCalls: 1 });
    } else assert.equal(occurrences(context.messages, fixture.marker), 0, 'OMP retains the existing explicit reload compatibility boundary');
    await rpc.prompt(`$${fixture.alias}@notion Inspect the workflow again after compression.`);
    assert.equal(occurrences((await captures()).at(-1).context.messages, fixture.marker), 1, 'Explicit selection after compaction must not duplicate the delivered body');
    if (host === 'pi') verifyPreparedProviderBody((await captures()).at(-1).context, fixture.name, expected);
    result.observations.push(host === 'pi'
      ? 'actual host compaction retains selected View; ordinary Pi restoration and explicit re-selection preserve one complete body'
      : 'actual OMP compaction retains selected View; explicit re-selection reloads one complete body');

    await stop();
    await save(configPath, { sources: [{ ...source, default_view_id: secondViewId }] });
    await boot();
    await command('/context-broker view');
    context = await metadata(secondViewId, firstViewId);
    assert.ok(current(context).includes('origin="configured"'));
    await command(`/context-broker view ${firstViewId}`);
    await command('/context-broker view default');
    context = await metadata(secondViewId, firstViewId);
    result.observations.push('configured View wins over API order; reset returns to configuration rather than global mutable state');

    await stop();
    await save(configPath, { sources: [{ ...source, default_view_id: '99999999-9999-4999-8999-999999999999' }] });
    await boot();
    await rpc.prompt('Continue an ordinary task despite invalid default View.');
    context = (await captures()).at(-1).context;
    assert.ok(current(context).includes('status="error"'));
    assert.equal(listed(context, names.alpha).length, 0);
    await rpc.prompt(`$${fixture.alias}@notion Apply an exact workflow despite invalid default configuration.`);
    assert.equal(occurrences((await captures()).at(-1).context.messages, fixture.marker), 1);
    result.observations.push('invalid configured View never falls back; ordinary turns and explicit Skill selection still work');
    await stop();
    await save(configPath, { sources: [source] });
    await fixture.setScenario('normal', { includeUnflagged: true, noViews: true });
    await boot();
    await rpc.prompt('Continue normally with an empty default directory.');
    context = (await captures()).at(-1).context;
    assert.ok(current(context).includes('status="empty"'));
    assert.equal(listed(context, names.alpha).length, 0);
    await rpc.prompt(`$${fixture.alias}@notion Inspect the explicit workflow.`);
    assert.equal(occurrences((await captures()).at(-1).context.messages, fixture.marker), 1);
    result.observations.push('verified no-Views result means empty metadata, not failure or all-library fallback');

    await stop();
    await fixture.setScenario('normal', { includeUnflagged: true, partialView: true, observeViewCoverage: true });
    const partialStart = (await rows(fixture.callsPath)).length, partialProviderStart = (await captures()).length;
    await boot();
    context = await metadata(firstViewId, secondViewId);
    const partialEntries = await retainSession('partial');
    assert.ok(rpc.frames.some(frame => frame.type === 'extension_ui_request' && JSON.stringify(frame).includes('CATALOG_INCOMPLETE')), 'Partial coverage must surface its actual source warning');
    await stop();
    const partialCalls = (await rows(fixture.callsPath)).slice(partialStart);
    const partialResponse = partialCalls.filter(call => call.command === 'catalog-response' && call.args.includes('--default-view')).at(-1)?.response;
    assert.ok(partialResponse, 'The actual selected-View CLI response must be retained');
    const partialProof = verifyPartialViewCoverage({ host, context, response: partialResponse, entries: partialEntries, fixture });
    const bodyCalls = calls => calls.filter(call => ['prepare', 'read', 'use', 'export'].includes(call.operation ?? call.command));
    assert.equal(bodyCalls(partialCalls).length, 0, 'Partial discovery must not prepare any selected or unselected body');
    assert.equal((await captures()).length - partialProviderStart, 1);
    result.observations.push({ action: 'nonempty partial View retains the exact returned metadata', ...partialProof,
      providerIndex: partialProviderStart, providerRequests: 1, sourceCallStart: partialStart, sourceCallCount: partialCalls.length, bodyCalls: 0 });

    await fixture.setScenario('normal', { includeUnflagged: true, failList: true, observeViewCoverage: true });
    const failureStart = (await rows(fixture.callsPath)).length;
    await boot();
    await rpc.prompt('Describe available workflow names without reading any files.');
    context = (await captures()).at(-1).context;
    assert.match(current(context), /<view source="notion" origin="first" status="error" code="NOTION_REQUEST_FAILED"\/>/u);
    assert.equal(nativeEntries(host, { messages: [{ role: 'system', content: current(context) }] }).length, 0, 'A failed View cannot reuse the partial member as a complete or empty directory');
    assert.ok(system(context).includes('LOCAL_METADATA_KEPT_413'));
    const failureCalls = (await rows(fixture.callsPath)).slice(failureStart);
    const failures = failureCalls.filter(call => call.command === 'catalog-response');
    assert.ok(failures.some(call => call.args.includes('--default-view')), 'The selected View request must reach the controlled failure');
    assert.ok(failures.every(call => call.response.ok === false && call.response.error.code === 'NOTION_REQUEST_FAILED'));
    assert.equal(bodyCalls(failureCalls).length, 0);
    for (const marker of [fixture.marker, unflaggedCanary, missingCanary, fixture.resourceCanary]) assert.equal(occurrences(context, marker), 0);
    result.observations.push({ action: 'source failure remains an error distinct from partial and empty', code: 'NOTION_REQUEST_FAILED',
      sourceCallStart: failureStart, sourceCallCount: failureCalls.length, providerIndex: (await captures()).length - 1, bodyCalls: 0 });

    await fixture.setScenario('normal', { includeUnflagged: true, observeViewCoverage: true });
    const recoveryStart = (await rows(fixture.callsPath)).length;
    await ready();
    context = await metadata(firstViewId, secondViewId);
    assert.ok(current(context).includes('partial="false"'));
    assert.equal(listed(context, names.alpha).length, 1); assert.equal(listed(context, names.beta).length, 0);
    assert.equal(occurrences(context, fixture.marker), 0);
    const recoveryCalls = (await rows(fixture.callsPath)).slice(recoveryStart);
    const recovered = recoveryCalls.filter(call => call.command === 'catalog-response' && call.args.includes('--default-view')).at(-1)?.response;
    assert.ok(recovered?.ok); assert.deepEqual(recovered.records.map(record => record.ref), [fixture.skillRef]);
    assert.equal(recovered.coverage.exhaustive, true); assert.deepEqual(recovered.coverage.failed_sources, []);
    assert.equal(bodyCalls(recoveryCalls).length, 0);
    result.observations.push({ action: 'public refresh after source recovery restores one complete View', providerIndex: (await captures()).length - 1,
      sourceCallStart: recoveryStart, sourceCallCount: recoveryCalls.length, bodyCalls: 0 });
    result.status = 'passed';
    return result;
  } catch (error) { result.status = 'failed'; result.error = error.message; error.results = [result]; throw error; }
  finally { try { await stop(); } finally { await fixture.setScenario('normal'); await save(rpcFile, allFrames); await save(resultFile, result); } }
}
