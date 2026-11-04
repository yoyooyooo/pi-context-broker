import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2), worker = args[0] === '--worker';
if (worker) args.shift();
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1];
  if (!['--package', '--fixture', '--pi-package', '--out'].includes(key) || !value || options.has(key)) throw new Error('Usage: node scripts/verify-notion-sdk-installed.mjs --package INSTALLED_BROKER --fixture fixture.json --pi-package PI_PACKAGE_JSON --out NEW_ABSOLUTE_DIRECTORY');
  options.set(key, resolve(value));
}
for (const key of ['--package', '--fixture', '--pi-package', '--out']) assert.ok(options.has(key), key + ' is required');
const packageRoot = options.get('--package'), out = options.get('--out');
const fixture = JSON.parse(await readFile(options.get('--fixture'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
async function inventory() {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(join(packageRoot, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'Packaged source/runtime may not route to a checkout');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { const bytes = await readFile(join(packageRoot, path)); files.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
    }
  }
  await walk('src'); await walk('dist');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

if (!worker) {
  await mkdir(out, { recursive: false, mode: 0o700 });
  const before = await inventory();
  await writeFile(join(out, 'package-before.json'), JSON.stringify(before, null, 2) + '\n', { mode: 0o600 });
  const env = JSON.parse(await readFile(fixture.env, 'utf8'));
  const runtime = JSON.parse(await readFile(join(packageRoot, 'dist/ntn-skills-runtime.json'), 'utf8'));
  await writeFile(join(out, 'plan.json'), JSON.stringify({ version: 1, node: process.version, packageRoot, fixture: options.get('--fixture'),
    runtime, driver_sha256: hash(await readFile(fileURLToPath(import.meta.url))), scenarios: ['one-root', 'two-roots', 'three-roots', 'binary-resource', 'wrong-scope', 'wrong-physical-owner', 'broken-required', 'cancel-before-sdk', 'cancel-before-materialization'],
    scope: 'Controlled offline snapshots; actual installed Node SDK/Broker and custom CLI comparison. This is not live Notion or real-model evidence.' }, null, 2) + '\n');
  const child = childProcess.spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', ...args], {
    cwd: out, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [], stderr = [];
  child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
  const exit = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
  await writeFile(join(out, 'stdout.log'), Buffer.concat(stdout), { mode: 0o600 });
  await writeFile(join(out, 'stderr.log'), Buffer.concat(stderr), { mode: 0o600 });
  const after = await inventory();
  await writeFile(join(out, 'package-after.json'), JSON.stringify(after, null, 2) + '\n', { mode: 0o600 });
  assert.deepEqual(after, before, 'Verification may not alter installed product files');
  await writeFile(join(out, 'worker-exit.json'), JSON.stringify({ ...exit, package_unchanged: true }) + '\n');
  const result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8').catch(() => '{"status":"failed","error":"NO_RESULT"}'));
  console.log(JSON.stringify({ ...result, evidence: out }));
  process.exitCode = exit.code === 0 && result.status === 'passed' ? 0 : 1;
} else {
  const sdkEvents = [], processEvents = [];
  const topic = channel('context-broker.notion-sdk');
  topic.subscribe(event => { sdkEvents.push(event); appendFileSync(join(out, 'sdk.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }); });
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function(command, argv, spawnOptions) {
    const child = originalSpawn.call(this, command, argv, spawnOptions);
    const started = process.hrtime.bigint();
    const start = { event: 'start', pid: child.pid, command: basename(String(command)), operation: Array.isArray(argv) ? argv.find(value => ['prepare', 'read', 'export'].includes(value)) ?? null : null, monotonic_ns: started.toString() };
    processEvents.push(start); appendFileSync(join(out, 'children.jsonl'), JSON.stringify(start) + '\n');
    child.once('close', (code, signal) => { const event = { event: 'close', pid: child.pid, code, signal, monotonic_ns: process.hrtime.bigint().toString() }; processEvents.push(event); appendFileSync(join(out, 'children.jsonl'), JSON.stringify(event) + '\n'); });
    return child;
  };
  // Count alternate process APIs as well. A default SDK call through any of
  // these APIs is a failed zero-child assertion, even if its PID is unavailable.
  for (const name of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    childProcess[name] = function(...values) {
      const event = { event: 'start', api: name, pid: null, command: basename(String(values[0])), operation: null, monotonic_ns: process.hrtime.bigint().toString() };
      processEvents.push(event); appendFileSync(join(out, 'children.jsonl'), JSON.stringify(event) + '\n');
      return original.apply(this, values);
    };
  }
  syncBuiltinESMExports();
  const { createJiti } = createRequire(options.get('--pi-package'))('jiti');
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const { prepareNotionSkills, loadNotionResource } = await jiti.import(join(packageRoot, 'src/notion-source.ts'));
  const source = { type: 'notion', id: 'sdk-fixture', namespace: 'sdk-fixture', database: fixture.database, activation: { offline: true }, cacheDir: join(out, 'host-cache'), prefetch: false };
  const records = fixture.snapshots.map(snapshot => ({ ...snapshot.record, source: 'notion', sourceId: source.id, sourceScope: fixture.scope,
    path: join(out, 'metadata', snapshot.record.alias, 'SKILL.md'), aliases: [], normalizedAliases: [], normalizedName: snapshot.record.alias,
    normalizedDescription: snapshot.record.description.toLowerCase(), autoloadEnabled: true, token: 'sdk-fixture/' + snapshot.record.alias }));
  const roots = fixture.roots.map(ref => records.find(record => ref.startsWith(record.ref + '?')));
  assert.ok(roots.every(Boolean));
  const rootPins = new Map(fixture.snapshots.map(snapshot => [snapshot.record.id, snapshot.snapshot_id]));
  const results = [], graphs = new Map();
  async function scenario(name, run) {
    const sdkBefore = sdkEvents.length, processesBefore = processEvents.length, started = process.hrtime.bigint();
    try {
      const details = await run();
      const sdk = sdkEvents.slice(sdkBefore), processes = processEvents.slice(processesBefore);
      const row = { name, status: 'passed', elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6, sdk_calls: sdk.filter(e => e.event === 'start').length,
        sdk_completed: sdk.filter(e => e.event === 'end').length, child_starts: processes.filter(e => e.event === 'start').length,
        child_closes: processes.filter(e => e.event === 'close').length, ...details };
      results.push(row); await writeFile(join(out, 'progress.json'), JSON.stringify(results, null, 2) + '\n');
    } catch (error) {
      results.push({ name, status: 'failed', code: error.code ?? error.name });
      await writeFile(join(out, 'result.json'), JSON.stringify({ status: 'failed', cases: results }, null, 2) + '\n');
      throw error;
    }
  }
  function proof(graph) {
    return graph.records.map(record => ({ id: record.id, scope: record.sourceScope, snapshot: record.snapshotId, version: record.versionId,
      body: record.body, files: record.entryManifest.files, fileBindings: record.fileBindings, materialized: record.entryManifest.materialized_paths,
      local_files_ready: record.entryManifest.local_files_ready, binding: record.preparationBinding })).sort((a, b) => a.id.localeCompare(b.id));
  }
  for (const [name, count] of [['one-root', 1], ['two-roots', 2], ['three-roots', 3]]) await scenario(name, async () => {
    const childBefore = processEvents.length, sdkBefore = sdkEvents.length;
    const sdk = await prepareNotionSkills(roots.slice(0, count), source, fixture.cwd, { purpose: 'use', rootPins, transport: 'sdk' });
    const observed = sdkEvents.slice(sdkBefore);
    assert.equal(processEvents.length, childBefore, 'Default SDK preparation must not spawn any CLI node read');
    assert.equal(observed.filter(e => e.event === 'start').length, 1);
    assert.equal(observed.filter(e => e.event === 'end').length, 1);
    const end = observed.find(e => e.event === 'end');
    assert.equal(end.metrics_observed, true); assert.ok(end.request_metrics); assert.equal(end.request_metrics.total_requests, 0);
    assert.equal(sdk.records.length, count + 1, 'Shared Required is prepared once');
    assert.equal(sdk.records.filter(record => record.id.endsWith(':base')).length, 1);
    for (const record of sdk.records) assert.equal(await readFile(record.path, 'utf8'), record.body);
    const comparisonBefore = processEvents.length;
    const cli = await prepareNotionSkills(roots.slice(0, count), { ...source, cacheDir: join(out, 'cli-host-cache'), command: [process.execPath, join(packageRoot, 'dist/ntn-skills.mjs')] }, fixture.cwd, { purpose: 'use', rootPins, transport: 'sdk' });
    const cliProcesses = processEvents.slice(comparisonBefore);
    assert.deepEqual(proof(sdk), proof(cli)); assert.deepEqual(sdk.lock, cli.lock);
    assert.equal(cliProcesses.filter(e => e.event === 'start').length, count + 2);
    assert.equal(cliProcesses.filter(e => e.event === 'start' && e.operation === 'read').length, count + 1);
    graphs.set(count, sdk);
    return { default_sdk_children: 0, default_sdk_http: 0, default_sdk_calls: 1, custom_cli_children: count + 2, prepared_nodes: sdk.records.length,
      bodies_sha256: hash(JSON.stringify(proof(sdk).map(({ id, body }) => ({ id, body })))), graph_lock: sdk.lock.sha256 };
  });
  await scenario('binary-resource', async () => {
    const record = graphs.get(1).records.find(record => record.id === roots[0].id), before = processEvents.length;
    const path = await loadNotionResource(record, 'assets/sample.bin', source, fixture.cwd, undefined, 'sdk');
    const bytes = await readFile(path);
    assert.equal(bytes.length, fixture.resource.bytes); assert.equal(hash(bytes), fixture.resource.sha256);
    assert.equal(processEvents.length, before); assert.equal(record.entryManifest.local_files_ready, true);
    return { bytes: bytes.length, sha256: hash(bytes), default_sdk_children: 0 };
  });
  await scenario('wrong-scope', async () => {
    await assert.rejects(prepareNotionSkills([{ ...roots[0], sourceScope: 'f'.repeat(64) }], source, fixture.cwd, { purpose: 'use', rootPins, transport: 'sdk' }), { code: 'SOURCE_PREPARATION_INVALID' });
  });
  await scenario('wrong-physical-owner', async () => {
    const foreign = records.find(record => record.id.includes('sdk-foreign-library'));
    await assert.rejects(prepareNotionSkills([{ ...roots[0], locator: { ...roots[0].locator, page_id: foreign.locator.page_id } }], source, fixture.cwd, { purpose: 'use', rootPins, transport: 'sdk' }), { code: 'SOURCE_PREPARATION_INVALID' });
  });
  await scenario('broken-required', async () => {
    const broken = records.find(record => fixture.broken.startsWith(record.ref + '?'));
    await assert.rejects(prepareNotionSkills([broken], source, fixture.cwd, { purpose: 'use', rootPins, transport: 'sdk' }), error => /^(PREPARE_|SNAPSHOT_|CACHE_)/.test(error.code));
  });
  await scenario('cancel-before-sdk', async () => {
    const controller = new AbortController(); controller.abort();
    const before = sdkEvents.length;
    await assert.rejects(prepareNotionSkills(roots.slice(0, 1), source, fixture.cwd, { purpose: 'use', rootPins, transport: 'sdk', signal: controller.signal }), { code: 'SOURCE_CANCELLED' });
    assert.equal(sdkEvents.length, before);
  });
  await scenario('cancel-before-materialization', async () => {
    const controller = new AbortController(), cancelledCache = join(out, 'cancelled-host-cache');
    const cancel = event => { if (event.event === 'end' && event.operation === 'consume') controller.abort(); };
    topic.subscribe(cancel);
    try {
      await assert.rejects(prepareNotionSkills(roots.slice(0, 1), { ...source, cacheDir: cancelledCache }, fixture.cwd, { purpose: 'use', rootPins, transport: 'sdk', signal: controller.signal }), { code: 'SOURCE_CANCELLED' });
      await assert.rejects(readdir(cancelledCache), { code: 'ENOENT' });
    } finally { topic.unsubscribe(cancel); }
  });
  assert.equal(processEvents.filter(e => e.event === 'start').length, processEvents.filter(e => e.event === 'close').length);
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: 'passed', node: process.version, cases: results, sdk_calls: sdkEvents.filter(e => e.event === 'start').length,
    custom_cli_children: processEvents.filter(e => e.event === 'start').length, child_closes: processEvents.filter(e => e.event === 'close').length }, null, 2) + '\n');
}
