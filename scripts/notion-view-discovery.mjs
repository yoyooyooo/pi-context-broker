import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isolatedEnv } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { database, firstViewId, secondViewId, unflaggedAlias, unflaggedCanary } from './notion-integration-fixture.mjs';

const save = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
async function rows(path) { try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
function system(context) {
  return [Array.isArray(context.systemPrompt) ? context.systemPrompt.join('\n') : context.systemPrompt ?? '', ...context.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? message.sections ?? ''))].join('\n');
}
function current(context) {
  const text = system(context);
  const matches = [...text.matchAll(/<ntn-skills-view-catalog>[\s\S]*?<\/ntn-skills-view-catalog>/g)];
  assert.equal(matches.length, 1, 'Exactly one current View directory in the model prompt');
  return matches[0][0];
}
const occurrences = (value, needle) => JSON.stringify(value).split(needle).length - 1;

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
  let rpc;
  const allFrames = [];
  const boot = async () => { rpc = await startRpc({ host, cwd: base, args, env }); };
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
  try {
    await boot();
    await command('/context-broker view');
    await command('/context-broker views');
    assert.equal((await captures()).length, 0, 'No model request before first user message');
    const before = (await rpc.command('get_messages')).messages;
    assert.equal(occurrences(before, 'ntn-skills-view-catalog'), 0, 'Startup must not persist a directory message');
    assert.equal(occurrences(before, fixture.marker), 0, 'Startup must not activate prepared bodies');
    let context = await metadata(firstViewId, secondViewId);
    assert.ok(current(context).includes('notion-ui-alpha'));
    assert.ok(!current(context).includes('notion-ui-beta'));
    assert.equal(occurrences(context, fixture.marker), 0);
    assert.equal(occurrences(context, unflaggedCanary), 0);
    result.observations.push('first actual request contains metadata only; startup and view commands make zero provider calls');

    const points = await rpc.command(host === 'pi' ? 'get_fork_messages' : 'get_branch_messages');
    const forkPoint = points.messages?.at(-1)?.entryId;
    assert.ok(forkPoint);
    await command(`/context-broker view ${secondViewId}`);
    context = await metadata(secondViewId, firstViewId);
    assert.ok(current(context).includes('notion-ui-beta'), 'Unchecked Skill belongs to selected View');
    assert.ok(!current(context).includes('notion-ui-alpha'));
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
    context = await metadata(secondViewId, firstViewId);
    assert.equal(occurrences(context.messages, fixture.marker), 1);
    result.observations.push('invalid View does not change working selection; process resume restores persisted session choice');

    const fork = await rpc.command(host === 'pi' ? 'fork' : 'branch', { entryId: forkPoint });
    assert.notEqual(fork.cancelled, true);
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
      await sibling.prompt('List the default workflow metadata without opening files.');
      const siblingContext = (await captures()).at(-1).context;
      assert.ok(current(siblingContext).includes(firstViewId));
      assert.ok(!current(siblingContext).includes(secondViewId));
      await metadata(secondViewId, firstViewId);
      result.observations.push('two live sessions sharing one profile keep independent View selections');
    } finally { await sibling.stop(); allFrames.push(...sibling.frames); }

    await rpc.prompt(`$${fixture.alias}@notion Inspect this workflow before the compression test.`);
    await rpc.prompt('Ordinary unrelated conversation filler. '.repeat(1800));
    const compacted = await rpc.command('compact', { customInstructions: 'Summarize ordinary conversation; do not retain skill bodies.' });
    assert.notEqual(compacted.cancelled, true);
    context = await metadata(secondViewId, firstViewId);
    assert.equal(occurrences(context.messages, fixture.marker), 0, 'Compaction may remove a loaded body without changing selected View');
    await rpc.prompt(`$${fixture.alias}@notion Inspect the workflow again after compression.`);
    assert.equal(occurrences((await captures()).at(-1).context.messages, fixture.marker), 1, 'Removed body is reloaded once instead of suppressed by an old loaded receipt');
    result.observations.push('actual host compaction retains selected View; removed bodies can be reloaded without stale deduplication');

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
    assert.ok(!current(context).includes('notion-ui-alpha'));
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
    assert.ok(!current(context).includes('notion-ui-alpha'));
    await rpc.prompt(`$${fixture.alias}@notion Inspect the explicit workflow.`);
    assert.equal(occurrences((await captures()).at(-1).context.messages, fixture.marker), 1);
    result.observations.push('verified no-Views result means empty metadata, not failure or all-library fallback');
    result.status = 'passed';
    return result;
  } catch (error) { result.status = 'failed'; result.error = error.message; error.results = [result]; throw error; }
  finally { await stop(); await save(rpcFile, allFrames); await save(resultFile, result); }
}
