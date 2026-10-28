import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedEnv, resolveHost, runCommand } from '../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { createRequestLedger } from './notion-default-context.mjs';
import { invokeJson } from './verification-command.mjs';

const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const rows = async path => {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, probe, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await pause(100); }
  assert.fail(`Cache lifecycle timed out: ${label}`);
}
const starts = requests => requests.filter(row => row.phase === 'started');
const bodyRequests = requests => starts(requests).filter(row => row.kind === 'ntn' && row.method === 'GET' && /(?:^|\/)(?:blocks\/|ai\/skills\/|pages\/[^/]+\/markdown(?:$|\/))/.test(row.path ?? ''));
const exportsStarted = requests => starts(requests).filter(row => row.kind === 'cli' && row.command === 'export');

// The UI process accepts automation instructions, then uses actual composer keys.
// No source response, clock, cache entry, or host session state is injected.
export async function runCacheNativeUi({ spec, base, ctl, editor, draft, key, type, texts, captures, toolPlanPath, launcher }) {
  await save(join(spec.channel, 'ready.json'), { base, provider: join(base, 'provider.jsonl') });
  let sequence = 0;
  while (true) {
    const request = await until('next owned UI action', async () => (await rows(join(spec.channel, 'commands.jsonl')))[sequence], 900000);
    sequence++;
    try {
      if (request.action === 'stop') {
        await draft('/quit'); key('enter');
        await until('owned composer exits', () => !editor());
      } else if (request.action === 'restart') {
        await draft('/quit'); key('enter');
        await until('old composer exits', () => !editor());
        ctl('run', `'${launcher.replaceAll("'", "'\\''")}'`);
        await until('new composer', () => editor()?.text === 'What are we cooking?');
      } else if (request.action === 'new') {
        await draft('/new'); key('enter');
        await until('new conversation composer', () => editor()?.text === 'What are we cooking?');
      } else {
        if (request.action === 'resource') await save(toolPlanPath, { trigger: request.text, id: request.id, path: request.path });
        const before = (await captures()).length;
        if (request.action === 'activate') {
          await draft('$');
          await until('actual dollar menu', () => ctl('tree', '.sf-overlay .sf-item').nodes.length > 0);
          ctl('shot', `${request.label}-bare-dollar`);
          type(spec.alias);
          await until('selected remote candidate', () => texts(ctl('tree', '.sf-overlay .sf-item.sel')).some(text => text.includes(spec.alias)));
          ctl('shot', `${request.label}-menu`);
          key('tab');
          await until('accepted exact capsule', () => editor()?.text?.replace(/\uf0eb\s*/g, '') === `$${spec.alias}@notion` && ctl('tree', '.sf-editor .sf-t-strong').nodes.length > 0);
          assert.equal((await captures()).length, before, 'Menu selection must not dispatch');
          ctl('shot', `${request.label}-accepted`);
          type(` ${request.text}`);
        } else await draft(request.text);
        key('enter');
        const expected = before + (request.action === 'resource' ? 2 : 1);
        await until('captured provider completion', async () => (await captures()).length >= expected && editor()?.text === 'What are we cooking?');
        assert.equal((await captures()).length, expected, 'Exactly one submission and expected tool round');
        ctl('shot', `${request.label}-response`);
      }
      await appendFile(join(spec.channel, 'responses.jsonl'), JSON.stringify({ id: request.id, status: 'passed', at: new Date().toISOString() }) + '\n');
      if (request.action === 'stop') return;
    } catch (error) {
      await appendFile(join(spec.channel, 'responses.jsonl'), JSON.stringify({ id: request.id, status: 'failed', error: error.message }) + '\n');
      throw error;
    }
  }
}

export async function runCacheLifecycle({ root, scratch, evidence, fixture, extension, database, command, scriptedProvider }) {
  const result = { mode: 'live-cache-lifecycle', status: 'running', readMaxAgeMs: 300000, surfaces: [], files: ['cache-lifecycle-result.json'], notRun: ['real model inference'] };
  const resultFile = join(evidence, result.files[0]);
  const consumers = [];
  const persist = () => save(resultFile, result);
  const ownerInvoke = (args, input) => invokeJson(['ntn'], ['api', ...args, '--notion-version', '2026-03-11', ...(input ? ['--data', '@-'] : [])], { input, cwd: scratch, evidence: join(evidence, 'command-receipts.jsonl'), category: 'owned-cache-edit' });
  const ownerCli = args => invokeJson(fixture.command ?? command, args, { cwd: scratch, evidence: join(evidence, 'command-receipts.jsonl'), category: 'owned-cache-edit' });
  const a = fixture.canary, ar = fixture.resourceCanary;
  const b = a + '_REVISION_B', br = ar + '_REVISION_B';
  let phase = 'unchecked owned fixture';
  try {
    await fixture.setDefaultContext(false);
    for (const host of ['pi', 'omp', 'tern-omp']) {
      phase = `${host} empty roots`;
      const base = join(scratch, `cache-${host}`), out = join(evidence, `cache-${host}`);
      await mkdir(join(base, 'agent', 'context-broker'), { recursive: true });
      await mkdir(join(base, 'sessions'), { recursive: true });
      await mkdir(out, { recursive: true });
      const ledger = await createRequestLedger({ scratch: base, evidence: out, command, ntnCommand: ['ntn'] });
      const source = { type: 'notion', id: 'notion', namespace: 'notion', command: ledger.command, database, cacheDir: join(base, 'source-cache'), requestTimeoutMs: 30000 };
      const config = join(base, 'agent', 'context-broker', 'config.yml');
      await save(config, { sources: [source] });
      const providerFile = join(out, 'provider.jsonl'), plan = join(base, 'tool-plan.json');
      const env = isolatedEnv({ base, agentDir: join(base, 'agent'), HOME: process.env.HOME, CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_HOST: host === 'pi' ? 'pi' : 'omp', CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerFile, CONTEXT_BROKER_LOG_FILE: join(out, 'decisions.jsonl'), BROKER_NOTION_TOOL_PLAN: plan });
      for (const name of ['NOTION_API_TOKEN', 'NTN_API_TOKEN']) if (process.env[name]) env[name] = process.env[name];
      const record = { host, status: 'running', observations: [], roots: { broker: source.cacheDir, cliState: env.NTN_SKILLS_HOME, cliCache: env.NTN_SKILLS_CACHE_HOME } };
      const consumer = { host, base, out, source, env, ledger, plan, providerFile, record };
      consumers.push(consumer); result.surfaces.push(record);
      record.initialFiles = await readdir(base, { recursive: true });
      assert.ok(!record.initialFiles.some(path => path.includes('/snapshots/') || path.endsWith('state.sqlite')), 'No downloaded content before host startup');
      {
        const specPath = join(base, 'ui-spec.json');
        const spec = { channel: out, source, alias: fixture.alias, env: Object.fromEntries(Object.entries(env).filter(([name]) => !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)/i.test(name))) };
        let executable = process.execPath, args = [join(root, 'scripts/verify-native-ui.mjs'), '--cache-lifecycle-spec', specPath];
        if (host !== 'tern-omp') {
          const provider = await scriptedProvider(base), native = await resolveHost(host);
          await save(plan, { trigger: 'NEVER', id: host, path: '/nonexistent' });
          await writeFile(join(base, 'agent/config.yml'), 'startup:\n  setupWizard: false\n  checkUpdate: false\ncompaction:\n  enabled: false\n');
          const hostArgs = host === 'pi'
            ? ['--no-extensions', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--approve', '--offline', '--tui-mode', 'regular']
            : ['--no-extensions', '--no-skills', '--no-rules', '--no-title'];
          Object.assign(spec, { host, cwd: base, provider: providerFile, plan, screenModuleDir: join(root, '.agents/skills/verify-context-broker/scripts'), command: [native.file, ...native.prefix, ...hostArgs, '--session-dir', join(base, 'sessions'), '--tools', 'read', '-e', provider, '-e', extension, '--model', 'context-broker-e2e/fake'] });
          executable = 'python3'; args = [join(root, 'scripts/notion-cache-terminal.py'), specPath];
        }
        await save(specPath, spec);
        const child = spawn(executable, args, { cwd: root, env: { ...process.env, BROKER_UI_EXTENSION: extension }, stdio: ['ignore', 'pipe', 'pipe'] });
        consumer.child = child;
        consumer.exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        child.stdout.on('data', chunk => appendFile(join(out, 'ui-stdout.log'), chunk));
        child.stderr.on('data', chunk => appendFile(join(out, 'ui-stderr.log'), chunk));
        child.on('error', error => { consumer.failure = error; });
        const ready = await until('owned Tern/OMP readiness', async () => {
          if (consumer.failure) throw consumer.failure;
          if (child.exitCode !== null || child.signalCode !== null) assert.fail('Owned native UI exited before readiness');
          try { return JSON.parse(await readFile(join(out, 'ready.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        });
        consumer.uiBase = ready.base; consumer.providerFile = ready.provider;
        record.uiEvidence = ready.base;
        let sequence = 0;
        consumer.action = async (action, extra = {}) => {
          const id = extra.id ?? `${host}-${++sequence}`;
          await appendFile(join(out, 'commands.jsonl'), JSON.stringify({ action, id, ...extra }) + '\n');
          const response = await until(`UI action ${action}`, async () => {
            const row = (await rows(join(out, 'responses.jsonl'))).find(row => row.id === id);
            if (row) return row;
            assert.equal(child.exitCode, null, 'Native UI must remain alive through the action');
          });
          assert.equal(response.status, 'passed', response.error);
          if (action === 'new' || action === 'restart') consumer.freshConversation = true;
        };
      }
      consumer.captures = () => rows(consumer.providerFile);
      consumer.requests = () => rows(ledger.ledger);
      consumer.probe = async () => {
        const output = await runCommand(ledger.command[0], [...ledger.command.slice(1), 'read', fixture.skillRef, '--database', database], { cwd: base, env });
        const value = JSON.parse(output.stdout); assert.notEqual(value.ok, false);
        return value;
      };
      consumer.observe = async (label, action, marker, forbidden, remote) => {
        phase = `${host} ${label}`; result.phase = phase; await persist();
        const before = (await consumer.requests()).length;
        const providersBefore = (await consumer.captures()).length;
        await consumer.action(action, { label, text: `CACHE_${label}: apply the selected instructions.` });
        const captures = await consumer.captures();
        assert.equal(captures.length, providersBefore + 1, 'One provider request per submission');
        const context = captures.at(-1).context;
        const messages = JSON.stringify(context.messages);
        if (consumer.freshConversation) {
          for (const previous of record.observations) assert.equal(messages.includes(`CACHE_${previous.label}:`), false, 'New conversation must exclude previous user turns');
          consumer.freshConversation = false;
        }
        assert.equal(messages.split(marker).length - 1, 1, 'Exactly one selected body in current context');
        assert.equal(messages.split(a).length - 1, 1, 'No second copy or mixed A/B revisions in current context');
        if (forbidden) assert.equal(messages.includes(forbidden), false, 'Wrong revision must not leak into effective context');
        const entries = (await readdir(source.cacheDir, { recursive: true })).filter(path => path.includes('/snapshots/') && path.endsWith('/SKILL.md'));
        const matching = [];
        for (const path of entries) {
          const body = await readFile(join(source.cacheDir, path), 'utf8');
          if (body.includes(marker) && (!forbidden || !body.includes(forbidden))) matching.push({ path, body });
        }
        assert.equal(matching.length, 1, 'One exact pinned export must identify the selected revision');
        const exported = matching[0].body.trimEnd();
        const rendered = exported.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        assert.ok(messages.includes(JSON.stringify(rendered).slice(1, -1)), 'Provider must contain the complete XML-escaped pinned source body including frontmatter');
        const calls = (await consumer.requests()).slice(before);
        if (remote === false) assert.equal(bodyRequests(calls).length, 0, 'Warm consumption must not download Notion bodies');
        if (remote === true) assert.ok(bodyRequests(calls).length > 0, 'Cold/expired activation must fetch real Notion bodies');
        const observation = { label, action, snapshot: matching[0].path.split('/snapshots/')[1].split('/')[0], bodySha256: createHash('sha256').update(matching[0].body).digest('hex'), bodyBytes: Buffer.byteLength(matching[0].body), bodyRequests: bodyRequests(calls).length, exports: exportsStarted(calls).length, providerRequests: 1, bodyCopies: 1, at: new Date().toISOString() };
        record.observations.push(observation); await persist();
        return observation;
      };
      // Metadata may finish before the first body activation; no read/export prewarm.
      await until(`${host} metadata`, async () => (await consumer.requests()).some(row => row.kind === 'cli' && row.command === 'list' && row.phase === 'completed' && row.code === 0));
      assert.equal(starts(await consumer.requests()).some(row => row.kind === 'cli' && ['read', 'export'].includes(row.command)), false, 'Unchecked fixture must remain cold');
      await consumer.observe('cold-a', 'activate', a, b, true);
      consumer.a = await consumer.probe();
      assert.equal(consumer.a.freshness.max_age_ms, 300000, 'Exercise the default five-minute policy');
      assert.equal(consumer.a.freshness.stale, false);
      await consumer.observe('same-session-a', 'activate', a, b, false);
      await consumer.action('new');
      const warm = await consumer.observe('new-session-a', 'activate', a, b, false);
      assert.equal(warm.exports, 0, 'New session must reuse complete immutable export');
      await consumer.action('restart');
      const restart = await consumer.observe('new-process-a', 'activate', a, b, false);
      assert.equal(restart.exports, 0, 'New process must reuse complete immutable export');
      const offline = await consumer.probe();
      assert.equal(offline.freshness.validated_at, consumer.a.freshness.validated_at, 'Cached hits never extend validation time');
      assert.equal(offline.snapshot_id, consumer.a.snapshot_id);
      record.revisionA = { snapshot: consumer.a.snapshot_id, validatedAt: consumer.a.freshness.validated_at };
      console.log(`Cache lifecycle ${host}: cold download and warm session/process reuse passed`);
    }
    phase = 'direct Notion edit'; result.phase = phase; await persist();
    const pageId = fixture.skillRef.split('/')[2];
    const children = async id => { const value = await ownerInvoke([`v1/blocks/${id}/children`]); assert.equal(value.has_more, false, 'Owned fixture block inventory must be complete'); return value.results; };
    const rootBlocks = await children(pageId);
    const guidePages = rootBlocks.filter(block => block.type === 'child_page' && block.child_page.title.includes('guide'));
    assert.equal(guidePages.length, 1, 'Edit only the exact owned guide page');
    const edits = [];
    for (const [blocks, oldMarker, newMarker] of [[rootBlocks, a, b], [await children(guidePages[0].id), ar, br]]) {
      const matches = blocks.filter(block => block.type === 'paragraph' && block.paragraph.rich_text.some(text => text.text?.content.includes(oldMarker)));
      assert.equal(matches.length, 1, 'Locate exactly one owned authored paragraph');
      const block = matches[0];
      const richText = block.paragraph.rich_text.map(text => { assert.equal(text.type, 'text'); return { type: 'text', text: { ...text.text, content: text.text.content.replace(oldMarker, newMarker) }, annotations: text.annotations }; });
      await ownerInvoke([`v1/blocks/${block.id}`, '-X', 'PATCH'], { paragraph: { rich_text: richText } });
      const observed = await ownerInvoke([`v1/blocks/${block.id}`]);
      assert.ok(observed.paragraph.rich_text.some(text => text.text?.content.includes(newMarker)));
      edits.push({ blockId: block.id, readback: true });
    }
    result.remoteEdit = { pageId, guidePageId: guidePages[0].id, edits, at: new Date().toISOString() };
    for (const consumer of consumers) {
      await consumer.observe('edited-same-session-a', 'activate', a, b, false);
      await consumer.action('new');
      await consumer.observe('edited-fresh-cache-a', 'activate', a, b, false);
    }
    phase = 'inspect and accept owned Notion edit'; result.phase = phase; await persist();
    let rejected;
    try { await ownerCli(['read', fixture.skillRef, '--database', database, '--refresh']); }
    catch (error) { rejected = error.recovery?.error?.code; }
    assert.equal(rejected, 'PUBLICATION_DIVERGED', 'Managed native edits must be refused until explicitly accepted');
    const inspected = await ownerCli(['operation', 'inspect-edit', pageId]);
    assert.equal(inspected.record.locator.page_id, pageId);
    assert.equal(inspected.requires_acceptance, true);
    assert.equal(inspected.publication.state, 'committed');
    for (const [path, marker] of [['SKILL.md', b], [fixture.resourcePath, br]]) {
      const file = inspected.files.find(file => file.path === path);
      assert.ok(file && Buffer.from(file.base64, 'base64').toString('utf8').includes(marker), 'Inspect the exact changed owned body and resource before acceptance');
    }
    result.remoteEdit.inspection = { rejectedBeforeAcceptance: rejected, version: inspected.version_id, snapshot: inspected.snapshot_id, contentHash: inspected.content_hash };
    await persist();
    const accepted = await ownerCli(['operation', 'accept-edit', pageId, '--expected-version', inspected.version_id]);
    assert.equal(accepted.record.locator.page_id, pageId);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.verified, true);
    result.remoteEdit.acceptance = { operationId: accepted.operation_id, expectedVersion: inspected.version_id, accepted: true, verified: true, at: new Date().toISOString() };
    await persist();
    // Use elapsed real time, never mutate timestamps or shorten the configured TTL.
    const expiresAt = Math.max(...consumers.map(consumer => Date.parse(consumer.a.freshness.validated_at))) + 300001;
    result.expiry = { notBefore: new Date(expiresAt).toISOString(), method: 'real elapsed time; default five-minute TTL' };
    result.phase = 'waiting for actual default cache expiry'; await persist();
    console.log(`Cache lifecycle: direct Notion edits verified; waiting until ${result.expiry.notBefore}`);
    while (Date.now() < expiresAt) await pause(Math.min(1000, expiresAt - Date.now()));
    for (const consumer of consumers) {
      await consumer.observe('expired-same-session-a', 'activate', a, b, false);
      await consumer.action('new');
      const latest = await consumer.observe('expired-new-session-b', 'activate', b, null, true);
      assert.equal(latest.exports, 1, 'New revision must export one new immutable snapshot');
      consumer.b = await consumer.probe();
      assert.notEqual(consumer.b.snapshot_id, consumer.a.snapshot_id, 'Notion edit must produce a different immutable snapshot');
      assert.ok(consumer.b.content.includes(b));
      const resource = (await readdir(consumer.source.cacheDir, { recursive: true })).filter(path => path.includes(`/snapshots/${consumer.b.snapshot_id}/`) && path.endsWith('/references/guide.md'));
      assert.equal(resource.length, 1, 'Updated resource must belong to the same new snapshot');
      const before = (await consumer.requests()).length;
      const trigger = `OPEN_CACHE_REVISION_B_${consumer.host}`;
      const id = `cache-resource-${consumer.host}`;
      await consumer.action('resource', { label: 'revision-b-resource', text: trigger, id, path: join(consumer.source.cacheDir, resource[0]) });
      const context = (await consumer.captures()).at(-1).context;
      const toolResult = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === id);
      assert.ok(toolResult && !toolResult.isError && JSON.stringify(toolResult).includes(br), 'Actual native tool must consume the matching B resource');
      assert.equal(bodyRequests((await consumer.requests()).slice(before)).length, 0, 'Pinned resource must not fetch Notion again');
      consumer.record.revisionB = { snapshot: consumer.b.snapshot_id, validatedAt: consumer.b.freshness.validated_at, resourceConsumed: true };
      consumer.record.status = 'passed'; await persist();
      console.log(`Cache lifecycle ${consumer.host}: old-session pin, expiry refresh and matching B resource passed`);
    }
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = error.message; result.phase = phase; error.results = [result]; throw error; }
  finally {
    const errors = [];
    for (const consumer of consumers) {
      try {
        if (consumer.child) {
          if (consumer.child.exitCode === null && consumer.child.signalCode === null) await consumer.action('stop');
          const exited = await consumer.exited; assert.equal(exited.code, 0, 'Owned UI process must exit successfully');
          assert.equal(JSON.parse(await readFile(join(consumer.uiBase, 'cleanup.json'), 'utf8')).stopped, true);
        }
      } catch (error) {
        errors.push({ host: consumer.host, error: error.message });
        if (consumer.child?.exitCode === null && consumer.child?.signalCode === null) { consumer.child.kill('SIGTERM'); await consumer.exited; }
      }
      result.files.push(...(await readdir(consumer.out)).filter(path => !path.endsWith('.log')).map(path => `cache-${consumer.host}/${path}`));
    }
    if (errors.length) { result.cleanupErrors = errors; result.status = 'failed'; process.exitCode = 1; }
    result.finishedAt = new Date().toISOString(); await persist();
  }
  assert.equal(result.status, 'passed', 'Cache lifecycle cleanup must pass before reporting success');
  return result;
}
