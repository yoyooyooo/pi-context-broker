#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, resolveHost, runCommand, signalHost, spawnHost, writeFakeProvider } from '../../../../packages/context-broker/scripts/context-broker-e2e-fixture.mjs';
import { startRpc } from '../../../../packages/context-broker/scripts/context-broker-rpc-harness.mjs';
import { createNotionFixture, database } from '../../../../scripts/notion-integration-fixture.mjs';
import { evidenceRoot, systemTempRoot } from '../../../../scripts/verification-paths.mjs';
import { waitForFile } from './concurrency-barriers.mjs';

const entry = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const product = join(root, 'packages/context-broker/src/notion-source.ts');
const extension = join(root, 'packages/context-broker/src/index.ts');
const transport = fileURLToPath(new URL('./concurrency-transport.mjs', import.meta.url));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const rows = async path => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = error => ({ message: error.message, code: error.code, stack: error.stack });
const cases = [
  { name: 'catalog-order', id: 'NS-SESSION-16', mode: 'storage', run: catalogOrder },
  { name: 'snapshot-race', id: 'NS-SESSION-17', mode: 'storage', run: snapshotRace },
  { name: 'host-first-body', id: 'NS-SESSION-18', mode: 'hosts', run: hostFirstBody },
  { name: 'snapshot-mismatch', id: 'NS-SESSION-19', mode: 'storage', run: snapshotMismatch },
  { name: 'catalog-equal-time', id: 'NS-SESSION-20', mode: 'storage', run: catalogOrder, newerOffset: -1_000 },
  { name: 'catalog-clock-rollback', id: 'NS-SESSION-21', mode: 'storage', run: catalogOrder, newerOffset: -3_000 },
];
const usage = `Usage: node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs doctor|run --mode storage|hosts [--case NAME[,NAME] ...] [--evidence-root ABSOLUTE_DIRECTORY]
       node .agents/skills/verify-notion-skills-integration/scripts/verify-cache-concurrency.mjs evidence|cleanup --evidence ABSOLUTE_DIRECTORY
Cases: catalog-order, snapshot-race, snapshot-mismatch, catalog-equal-time, catalog-clock-rollback (storage); host-first-body (hosts).
Storage uses isolated fixture processes and Bun to import the checkout's TypeScript source. Hosts uses actual Pi and OMP with controlled source/provider. No credentials or remote Notion are used. All selected cases retain independent assertions and failures. Help creates no files.`;

async function worker() {
  const { source, cwd, activate, refresh } = JSON.parse(process.argv[3]);
  try {
    const { discoverNotionSource, loadNotionSkill } = await import(product);
    const options = { refresh, signal: AbortSignal.timeout(90_000) };
    const records = await discoverNotionSource(source, cwd, options);
    const loaded = activate ? await loadNotionSkill(records[0], source, cwd, options) : undefined;
    console.log(JSON.stringify({ ok: true, records, list: records.list, loaded }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: failure(error) }));
    process.exitCode = 1;
  }
}

function parse() {
  const argv = process.argv.slice(2);
  if (argv.some(value => ['--help', '-h', 'help'].includes(value))) return { help: true };
  const action = argv.shift() ?? 'run';
  assert.ok(['doctor', 'run', 'evidence', 'cleanup'].includes(action), usage);
  const options = { action, mode: 'storage', selectors: [] };
  const seen = new Set();
  while (argv.length) {
    const flag = argv.shift(), value = argv.shift();
    assert.ok(['--mode', '--case', '--evidence', '--evidence-root'].includes(flag) && value && !value.startsWith('--'), usage);
    assert.ok(flag === '--case' || !seen.has(flag), `Duplicate option ${flag}`);
    seen.add(flag);
    if (flag === '--case') options.selectors.push(...value.split(','));
    else options[flag.slice(2)] = value;
  }
  assert.ok(['storage', 'hosts'].includes(options.mode), usage);
  options.selected = options.selectors.length ? [...new Set(options.selectors)].map(name => {
    const selected = cases.find(item => item.name === name || item.id === name);
    assert.ok(selected && selected.mode === options.mode, `Case ${name} is unavailable in ${options.mode} mode`);
    return selected;
  }) : cases.filter(item => item.mode === options.mode);
  if (['evidence', 'cleanup'].includes(action)) assert.ok(isAbsolute(options.evidence ?? ''), '--evidence must be absolute');
  return options;
}

async function doctor(options, evidence, scratch) {
  const result = { status: 'ready', mode: options.mode, cases: options.selected.map(item => item.name), node: process.versions.node, credentials: 'not inherited; no remote requests', tools: [], failures: [] };
  const env = isolatedEnv({ base: scratch, agentDir: join(scratch, 'agent'), TMPDIR: await systemTempRoot() });
  for (const host of options.mode === 'storage' ? ['bun'] : ['pi', 'omp']) {
    try {
      const command = await resolveHost(host);
      const output = await runCommand(host, ['--version'], { cwd: scratch, env, timeoutMs: 10_000 });
      result.tools.push({ host, command, version: output.stdout.trim() });
    } catch (error) { result.failures.push({ host, ...failure(error) }); }
  }
  for (const path of [product, transport, ...(options.mode === 'hosts' ? [extension] : [])]) {
    try { const bytes = await readFile(path); result.tools.push({ path, bytes: bytes.length, sha256: digest(bytes) }); }
    catch (error) { result.failures.push({ path, ...failure(error) }); }
  }
  if (result.failures.length) result.status = 'blocked';
  await save(join(evidence, 'doctor.json'), result);
  return result;
}

async function setup(context, gates) {
  const directory = join(context.scratch, context.name);
  const evidence = join(context.evidence, context.name);
  const gateDir = join(evidence, 'gates');
  await mkdir(directory, { recursive: true });
  await mkdir(gateDir, { recursive: true });
  const fixture = await createNotionFixture(join(directory, 'fixture'));
  await fixture.setScenario('normal', { cacheIdentity: true, defaultContext: false, catalogTtlMs: 3_600_000 });
  await writeFile(fixture.callsPath, '');
  const controls = [];
  const source = async (consumer, options = {}) => {
    const settings = join(directory, `${consumer}-transport.json`);
    const config = { command: fixture.command, directory: gateDir, gates, ...options };
    await save(settings, config);
    controls.push({ consumer, config });
    return { type: 'notion', id: consumer, namespace: consumer, command: [process.execPath, transport, settings, consumer], database, cacheDir: join(directory, 'cache') };
  };
  const event = value => appendFile(join(evidence, 'gates.jsonl'), JSON.stringify({ ...value, at: new Date().toISOString() }) + '\n');
  await writeFile(join(evidence, 'gates.jsonl'), '');
  const ready = async (operation, consumer) => {
    const path = join(gateDir, `${operation}.${consumer}.ready.json`);
    await waitForFile(path);
    const receipt = await json(path);
    await event({ event: 'ready-observed', operation, consumer });
    return receipt.result;
  };
  const release = async (operation, consumer) => {
    await event({ event: 'release', operation, consumer });
    await writeFile(join(gateDir, `${operation}.${consumer}.release`), 'release\n');
  };
  const releaseAll = async () => {
    const settled = await Promise.allSettled(controls.flatMap(({ consumer, config }) => config.gates.map(operation => release(operation, consumer))));
    for (const item of settled) if (item.status === 'rejected') context.result.failures.push({ phase: 'release-finally', ...failure(item.reason) });
  };
  return { ...context, directory, evidence, fixture, cache: join(directory, 'cache'), source, ready, release, releaseAll };
}

async function launchWorker(test, consumer, source, activate = true, refresh = false) {
  const cwd = join(test.directory, consumer);
  await mkdir(cwd, { recursive: true });
  const env = isolatedEnv({ base: cwd, agentDir: join(cwd, 'agent'), TMPDIR: await systemTempRoot() });
  const child = await spawnHost('bun', [entry, '__worker', JSON.stringify({ source, cwd, activate, refresh })], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  let escalation;
  const completed = new Promise(resolveResult => {
    const timer = setTimeout(() => {
      signalHost(child, 'SIGTERM');
      escalation = setTimeout(() => signalHost(child, 'SIGKILL'), 2_000);
    }, 110_000);
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); resolveResult({ ok: false, error: failure(error) }); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation);
      let data;
      try { data = JSON.parse(Buffer.concat(stdout).toString('utf8')); } catch {}
      resolveResult({ ok: code === 0 && data?.ok === true, code, signal, data, stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
  return { consumer, completed };
}

async function check(result, name, assertion) {
  try { const detail = await assertion(); result.assertions.push({ name, status: 'passed', detail }); }
  catch (error) { result.assertions.push({ name, status: 'failed', error: failure(error) }); result.failures.push({ assertion: name, ...failure(error) }); }
}

async function inventory(directory) {
  const output = [];
  async function walk(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      assert.equal(item.isSymbolicLink(), false, 'Snapshot inventory must not contain symlinks');
      if (item.isDirectory()) await walk(child);
      else {
        assert.ok(item.isFile(), 'Snapshot inventory must contain regular files only');
        if (item.name === '.broker-snapshot.json') continue;
        const bytes = await readFile(child);
        output.push({ path: relative(directory, child).split(sep).join('/'), bytes: bytes.length, hash: digest(bytes) });
      }
    }
  }
  await walk(directory);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

async function cacheState(test) {
  let paths;
  try { paths = await readdir(test.cache, { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; paths = []; }
  const stages = paths.filter(path => path.split(sep).at(-1).startsWith('.stage-'));
  const snapshots = [];
  for (const path of paths.filter(path => path.endsWith(`${sep}.broker-snapshot.json`) && !path.split(sep).slice(0, -1).some(part => part.startsWith('.')))) {
    const directory = dirname(join(test.cache, path));
    const receipt = await json(join(directory, '.broker-snapshot.json'));
    const body = await readFile(join(directory, receipt.entry));
    snapshots.push({ directory, receipt, inventory: await inventory(directory), body: body.toString('utf8'), bytes: body.length, sha256: digest(body) });
  }
  const calls = await rows(test.fixture.callsPath);
  return { snapshots, stages, calls: { list: calls.filter(item => item.command === 'list').length, read: calls.filter(item => item.command === 'read').length, export: calls.filter(item => item.command === 'export' && item.phase === 'completed').length } };
}

async function catalog(test) {
  const keys = await readdir(join(test.cache, 'catalogs-v4'));
  assert.equal(keys.length, 1, 'Equivalent consumers publish one catalog identity');
  const directory = join(test.cache, 'catalogs-v4', keys[0], 'published');
  const order = (await readdir(directory)).filter(name => /^[0-9]{20}$/.test(name)).sort().at(-1);
  return json(join(directory, order, 'receipt.json'));
}

async function catalogOrder(context) {
  const test = await setup(context, ['list']);
  const jobs = [];
  try {
    const anchor = Date.now() - 1_000;
    const olderSource = await test.source('older', { validatedAt: new Date(anchor - 1_000).toISOString() });
    const older = await launchWorker(test, 'older', olderSource, false);
    jobs.push(older);
    const held = await test.ready('list', 'older');
    await test.fixture.setScenario('normal', { cacheIdentity: true, defaultContext: false, catalogTtlMs: 3_600_000, alias: 'newer-alias' });
    const newerSource = await test.source('newer', { gates: [], validatedAt: new Date(anchor + (context.newerOffset ?? 0)).toISOString() });
    const newer = await launchWorker(test, 'newer', newerSource, false, true);
    jobs.push(newer);
    const published = await newer.completed;
    assert.ok(published.ok, 'The newer discovery must finish before releasing the older response');
    const before = await catalog(test);
    await save(join(test.evidence, 'newer-published.json'), { published, catalog: before });
    await test.release('list', 'older');
    const delayed = await older.completed;
    const after = await catalog(test);
    const lookup = await launchWorker(test, 'lookup', await test.source('lookup', { gates: [] }), false);
    jobs.push(lookup);
    const observed = await lookup.completed;
    await save(join(test.evidence, 'observations.json'), { held, published, delayed, observed, before, after });
    await check(context.result, 'both-discoveries-complete', () => assert.ok(published.ok && delayed.ok, 'Both independently started discoveries must complete'));
    await check(context.result, 'newer-observation-published-first', () => assert.equal(before.result.records[0].alias, 'newer-alias'));
    await check(context.result, 'catalog-alias-does-not-roll-back', () => assert.equal(after.result.records[0].alias, 'newer-alias', 'A delayed older list must not replace the newer alias'));
    await check(context.result, 'catalog-validation-does-not-roll-back', () => assert.equal(after.result.freshness.validated_at, before.result.freshness.validated_at, 'A delayed older list must not replace the newer validated_at'));
    await check(context.result, 'catalog-index-does-not-roll-back', () => assert.equal(after.indexId, before.indexId, 'The published newer index must remain selected'));
    await check(context.result, 'independent-lookup-retains-newer-catalog', () => {
      assert.ok(observed.ok);
      assert.equal(observed.data.records[0].alias, 'newer-alias');
      assert.equal(observed.data.list.validatedAt, before.result.freshness.validated_at);
    });
    await check(context.result, 'active-metadata-indexes-remain-readable', async () => {
      for (const outcome of [published, delayed]) for (const record of outcome.data.records) await access(record.path);
    });
  } finally {
    await test.releaseAll();
    await save(join(test.evidence, 'workers.json'), await Promise.all(jobs.map(job => job.completed)));
    await copyFile(test.fixture.callsPath, join(test.evidence, 'source-cli-calls.jsonl'));
  }
}

async function pairReady(test, operation, consumers) {
  return Promise.all(consumers.map(consumer => test.ready(operation, consumer)));
}

async function pairRelease(test, operation, consumers) {
  await Promise.all(consumers.map(consumer => test.release(operation, consumer)));
}

async function snapshotAssertions(test, reads, outputs) {
  const result = test.result;
  await check(result, 'both-snapshot-loads-succeed', () => assert.ok(outputs.length === 2 && outputs.every(item => item.ok), 'Both loads must succeed; duplicate read/export is permitted'));
  await check(result, 'both-loads-return-complete-matching-bytes', async () => {
    assert.equal(reads[0].content, reads[1].content);
    for (const output of outputs) {
      assert.ok(output.ok, 'Each independent load must succeed');
      const loaded = output.data.loaded;
      assert.equal(loaded.body, reads[0].content);
      assert.deepEqual(await readFile(loaded.path), Buffer.from(reads[0].content));
    }
    assert.equal(outputs[0].data.loaded.path, outputs[1].data.loaded.path);
    assert.equal(outputs[0].data.loaded.snapshotId, reads[0].snapshot_id);
    assert.equal(outputs[1].data.loaded.snapshotId, reads[0].snapshot_id);
  });
  await inspectSnapshot(test, reads[0]);
}

async function inspectSnapshot(test, read) {
  const state = await cacheState(test);
  await save(join(test.evidence, 'cache-state.json'), state);
  await check(test.result, 'one-complete-immutable-snapshot', () => {
    assert.equal(state.snapshots.length, 1);
    const snapshot = state.snapshots[0];
    assert.equal(snapshot.receipt.snapshot, read.snapshot_id);
    assert.equal(snapshot.body, read.content);
    assert.deepEqual(snapshot.inventory, snapshot.receipt.files);
    assert.deepEqual(snapshot.inventory.map(item => item.path), ['.ntn-skills.json', 'references/ledger.md', 'SKILL.md'].sort((a, b) => a.localeCompare(b)));
    assert.equal(snapshot.inventory.find(item => item.path === 'references/ledger.md').hash, digest(Buffer.from(test.fixture.resourceCanary + '\n')));
  });
  await check(test.result, 'no-losing-stage-in-active-cache', () => assert.deepEqual(state.stages, [], 'Identical concurrent publication must retire the losing .stage-* from the active cache'));
  return state;
}

async function snapshotRace(context) {
  const test = await setup(context, ['read', 'export']);
  const jobs = [];
  try {
    for (const consumer of ['a', 'b']) jobs.push(await launchWorker(test, consumer, await test.source(consumer)));
    const reads = await pairReady(test, 'read', ['a', 'b']);
    await pairRelease(test, 'read', ['a', 'b']);
    const exports = await pairReady(test, 'export', ['a', 'b']);
    await save(join(test.evidence, 'both-exports-staged.json'), exports);
    await test.release('export', 'a');
    await jobs[0].completed;
    await test.release('export', 'b');
    const outputs = await Promise.all(jobs.map(job => job.completed));
    await save(join(test.evidence, 'workers.json'), outputs);
    await snapshotAssertions(test, reads, outputs);
  } finally {
    await test.releaseAll();
    await save(join(test.evidence, 'workers.json'), await Promise.all(jobs.map(job => job.completed)));
    await copyFile(test.fixture.callsPath, join(test.evidence, 'source-cli-calls.jsonl'));
  }
}

async function snapshotMismatch(context) {
  const test = await setup(context, ['read', 'export']);
  const jobs = [];
  try {
    for (const consumer of ['winner', 'mismatch']) jobs.push(await launchWorker(test, consumer, await test.source(consumer, { mismatchResource: consumer === 'mismatch' })));
    const reads = await pairReady(test, 'read', ['winner', 'mismatch']);
    await pairRelease(test, 'read', ['winner', 'mismatch']);
    const exports = await pairReady(test, 'export', ['winner', 'mismatch']);
    await save(join(test.evidence, 'both-exports-staged.json'), exports);
    await test.release('export', 'winner');
    const winner = await jobs[0].completed;
    assert.ok(winner.ok, 'Control snapshot must publish before mismatched contender');
    const before = await cacheState(test);
    await test.release('export', 'mismatch');
    const loser = await jobs[1].completed;
    const after = await cacheState(test);
    await save(join(test.evidence, 'cache-state.json'), { before, after });
    await check(context.result, 'negative-control-changes-resource-only', () => {
      assert.equal(reads[0].content, reads[1].content);
      assert.equal(reads[0].snapshot_id, reads[1].snapshot_id);
      assert.notDeepEqual(exports[0].files, exports[1].files);
    });
    await check(context.result, 'mismatched-export-fails-explicitly', () => {
      assert.equal(loser.ok, false);
      assert.equal(loser.data?.error?.code, 'SOURCE_OUTPUT_CONFLICT', 'Valid but different immutable bytes must remain an explicit output conflict');
    });
    await check(context.result, 'mismatched-export-cannot-replace-winner', () => {
      assert.deepEqual(after.snapshots, before.snapshots);
      assert.equal(after.snapshots.length, 1);
      assert.equal(after.snapshots[0].body, reads[0].content);
    });
  } finally {
    await test.releaseAll();
    await save(join(test.evidence, 'workers.json'), await Promise.all(jobs.map(job => job.completed)));
    await copyFile(test.fixture.callsPath, join(test.evidence, 'source-cli-calls.jsonl'));
  }
}

async function hostFirstBody(context) {
  const test = await setup(context, ['read', 'export']);
  const peers = [];
  const prompts = [];
  try {
    const opened = await Promise.allSettled(['pi', 'omp'].map(async host => {
      const base = join(test.directory, host), agentDir = join(base, 'agent');
      await mkdir(join(agentDir, 'context-broker'), { recursive: true });
      const config = join(agentDir, 'context-broker', 'config.yml');
      await save(config, { sources: [await test.source(host)] });
      const provider = await writeFakeProvider(base);
      const output = join(test.evidence, `${host}-provider.jsonl`);
      const decisions = join(test.evidence, `${host}-decisions.jsonl`);
      await writeFile(output, ''); await writeFile(decisions, '');
      const env = isolatedEnv({ base, agentDir, TMPDIR: await systemTempRoot(), CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: output, CONTEXT_BROKER_LOG_FILE: decisions });
      const args = ['--no-extensions', '--session-dir', join(base, 'sessions'), '--tools', 'read', '-e', provider, '-e', extension, '--model', 'context-broker-e2e/fake', ...(host === 'omp' ? ['--no-title', '--no-rules'] : [])];
      const rpc = await startRpc({ host, cwd: base, env, args });
      const peer = { host, rpc, output };
      peers.push(peer);
      await rpc.prompt('/context-broker refresh');
      return peer;
    }));
    await save(join(test.evidence, 'discovery.json'), opened.map((item, index) => ({ host: ['pi', 'omp'][index], status: item.status, error: item.status === 'rejected' ? failure(item.reason) : undefined })));
    for (let index = 0; index < opened.length; index++) if (opened[index].status === 'rejected') context.result.failures.push({ host: ['pi', 'omp'][index], phase: 'actual-host-discovery', ...failure(opened[index].reason) });
    assert.ok(opened.every(item => item.status === 'fulfilled'), 'Actual Pi and OMP discovery must both finish before body submissions');
    await check(context.result, 'finished-discovery-is-body-cold', async () => {
      const calls = await rows(test.fixture.callsPath);
      assert.equal(calls.filter(item => ['read', 'export'].includes(item.command)).length, 0);
      for (const peer of peers) assert.equal((await rows(peer.output)).length, 0);
    });
    for (const host of ['pi', 'omp']) {
      const peer = peers.find(item => item.host === host);
      prompts.push({ host, completed: peer.rpc.prompt(`$${test.fixture.alias}@${host} Apply these instructions to this concurrent task.`).then(value => ({ ok: true, value }), error => ({ ok: false, error: failure(error) })) });
    }
    const reads = await pairReady(test, 'read', ['pi', 'omp']);
    await pairRelease(test, 'read', ['pi', 'omp']);
    await pairReady(test, 'export', ['pi', 'omp']);
    await check(context.result, 'no-provider-before-body-publication', async () => {
      for (const peer of peers) assert.equal((await rows(peer.output)).length, 0);
    });
    await test.release('export', 'pi');
    await prompts[0].completed;
    await test.release('export', 'omp');
    const completions = await Promise.all(prompts.map(async prompt => ({ host: prompt.host, ...await prompt.completed })));
    await save(join(test.evidence, 'completions.json'), completions);
    for (let index = 0; index < 2; index++) await check(context.result, `${['pi', 'omp'][index]}-actual-first-body-completes`, () => assert.equal(completions[index].ok, true));
    for (let index = 0; index < 2; index++) {
      const host = ['pi', 'omp'][index];
      await check(context.result, `${host}-provider-has-complete-body-once`, async () => {
        const peer = peers.find(item => item.host === host);
        const captures = await rows(peer.output);
        assert.equal(captures.length, 1, 'First body submission must produce one controlled provider request');
        const messages = JSON.stringify(captures[0].context.messages);
        const expected = JSON.stringify(reads[index].content.trimEnd().replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')).slice(1, -1);
        assert.equal(messages.split(expected).length - 1, 1, 'Actual host provider must receive the complete pinned body including frontmatter exactly once');
        assert.equal(messages.split(test.fixture.canary).length - 1, 1);
      });
    }
    await check(context.result, 'host-reads-match-complete-bytes', () => {
      assert.equal(reads[0].content, reads[1].content);
      assert.equal(reads[0].snapshot_id, reads[1].snapshot_id);
    });
    await inspectSnapshot(test, reads[0]);
  } finally {
    await test.releaseAll();
    const completed = await Promise.all(prompts.map(async prompt => ({ host: prompt.host, ...await prompt.completed })));
    await save(join(test.evidence, 'completions.json'), completed);
    for (const outcome of completed) if (!outcome.ok && !context.result.failures.some(item => item.host === outcome.host && item.phase === 'body-submission')) {
      context.result.failures.push({ host: outcome.host, phase: 'body-submission', ...outcome.error });
    }
    const stopped = await Promise.allSettled(peers.map(async peer => {
      try { await peer.rpc.stop(); }
      finally { await save(join(test.evidence, `${peer.host}-rpc.json`), peer.rpc.frames); }
    }));
    for (let index = 0; index < stopped.length; index++) if (stopped[index].status === 'rejected') context.result.failures.push({ host: peers[index].host, phase: 'teardown', ...failure(stopped[index].reason) });
    await copyFile(test.fixture.callsPath, join(test.evidence, 'source-cli-calls.jsonl'));
  }
}

async function ownedExits(evidence) {
  const events = await rows(join(evidence, 'owned-processes.jsonl'));
  const spawned = events.filter(item => item.event === 'spawn');
  const pending = spawned.filter(item => !events.some(end => end.event === 'close' && end.pid === item.pid && end.observedExit));
  return { spawned: spawned.length, observedExits: spawned.length - pending.length, pending };
}

async function evidenceCheck(directory) {
  const manifest = await json(join(directory, 'manifest.json'));
  const missing = [];
  for (const file of manifest.files) {
    assert.ok(!isAbsolute(file) && !file.split('/').includes('..'), 'Evidence inventory must stay inside its owned directory');
    try { await access(join(directory, file)); } catch (error) { missing.push({ file, code: error.code }); }
  }
  return { status: missing.length ? 'incomplete' : 'preserved', functionalStatus: manifest.status, mode: manifest.mode, cases: manifest.cases, missing, processes: await ownedExits(directory), cleanup: await json(join(directory, 'cleanup.json')).catch(error => error.code === 'ENOENT' ? { status: 'not-run' } : Promise.reject(error)) };
}

async function cleanup(directory) {
  directory = await realpath(directory);
  const manifest = await json(join(directory, 'manifest.json'));
  if (manifest.cleanup?.status === 'trashed') return { status: 'already-trashed', evidence: directory };
  const processes = await ownedExits(directory);
  assert.equal(processes.pending.length, 0, 'Owned process close evidence is required before cleanup');
  const scratch = await realpath(manifest.scratch);
  assert.ok(dirname(scratch) === await systemTempRoot() && scratch.split(sep).at(-1).startsWith('broker-concurrency-scratch-'), 'Refuse non-owned scratch');
  assert.equal((await lstat(scratch)).isSymbolicLink(), false);
  const ownership = await json(join(scratch, 'ownership.json'));
  assert.equal(ownership.evidence, directory);
  assert.equal(ownership.runId, manifest.runId);
  await resolveHost('/usr/bin/trash');
  await runCommand('/usr/bin/trash', [scratch], { cwd: await systemTempRoot(), env: isolatedEnv({ base: await systemTempRoot(), agentDir: join(await systemTempRoot(), 'broker-concurrency-cleanup-unused') }), timeoutMs: 10_000 });
  const receipt = { status: 'trashed', scratch, evidencePreserved: true, processes };
  await save(join(directory, 'cleanup.json'), receipt);
  manifest.cleanup = receipt;
  if (!manifest.files.includes('cleanup.json')) manifest.files.push('cleanup.json');
  await save(join(directory, 'manifest.json'), manifest);
  return receipt;
}

async function main() {
  const options = parse();
  if (options.help) { console.log(usage); return; }
  if (options.action === 'evidence') {
    const value = await evidenceCheck(options.evidence);
    console.log(JSON.stringify(value, null, 2));
    if (value.missing.length || value.processes.pending.length) process.exitCode = 1;
    return;
  }
  if (options.action === 'cleanup') { console.log(JSON.stringify(await cleanup(options.evidence), null, 2)); return; }
  const temporaryRoot = await systemTempRoot();
  const evidence = await mkdtemp(join(await evidenceRoot(options['evidence-root'], temporaryRoot), 'broker-concurrency-evidence-'));
  const scratch = await mkdtemp(join(temporaryRoot, 'broker-concurrency-scratch-'));
  const manifest = { runId: randomUUID(), action: options.action, mode: options.mode, command: [process.execPath, ...process.argv.slice(1)], status: 'running', scratch, evidence, cases: [], files: ['doctor.json', 'owned-processes.jsonl'], notRun: cases.filter(item => !options.selected.includes(item)).map(item => item.name) };
  await save(join(scratch, 'ownership.json'), { evidence, runId: manifest.runId });
  await writeFile(join(evidence, 'owned-processes.jsonl'), '');
  process.env.BROKER_E2E_PROCESS_LEDGER = join(evidence, 'owned-processes.jsonl');
  await save(join(evidence, 'manifest.json'), manifest);
  console.log(JSON.stringify({ status: 'running', evidence, scratch }));
  try {
    manifest.doctor = await doctor(options, evidence, scratch);
    if (manifest.doctor.status !== 'ready') { manifest.status = 'blocked'; process.exitCode = 1; return; }
    if (options.action === 'doctor') { manifest.status = 'ready'; console.log(JSON.stringify(manifest.doctor, null, 2)); return; }
    for (const selected of options.selected) {
      const result = { name: selected.name, id: selected.id, status: 'running', assertions: [], failures: [] };
      manifest.cases.push(result);
      try { await selected.run({ ...selected, scratch, evidence, result }); }
      catch (error) { result.failures.push({ phase: 'case-execution', ...failure(error) }); }
      result.status = result.failures.length ? 'failed' : 'passed';
      await save(join(evidence, `${selected.name}-result.json`), result);
      await save(join(evidence, 'manifest.json'), manifest);
      console.log(JSON.stringify({ case: selected.name, id: selected.id, status: result.status, failures: result.failures }));
    }
    manifest.status = manifest.cases.every(item => item.status === 'passed') ? 'passed' : 'failed';
    if (manifest.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    manifest.status = 'failed'; manifest.error = failure(error); process.exitCode = 1;
  } finally {
    manifest.processes = await ownedExits(evidence);
    if (manifest.processes.pending.length) { manifest.status = 'failed'; process.exitCode = 1; }
    const entries = await readdir(evidence, { recursive: true, withFileTypes: true });
    for (const item of entries) if (item.isFile()) {
      const file = relative(evidence, join(item.parentPath ?? item.path, item.name)).split(sep).join('/');
      if (file !== 'manifest.json') manifest.files.push(file);
    }
    manifest.files = [...new Set(manifest.files)].sort();
    await save(join(evidence, 'manifest.json'), manifest);
    console.log(JSON.stringify({ status: manifest.status, evidence, scratch, cases: manifest.cases.map(item => ({ name: item.name, status: item.status })) }));
  }
}

if (process.argv[2] === '__worker') await worker();
else await main().catch(error => { console.error(JSON.stringify({ status: 'failed', error: failure(error) })); process.exitCode = 1; });
