import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyBundledRuntime } from './verify-package-closure.mjs';

const args = process.argv.slice(2), worker = args[0] === '--worker';
if (worker) args.shift();
const keys = ['--package', '--fixture', '--source-http-helper', '--pi-package', '--out'];
const usage = 'Usage: node scripts/verify-notion-sdk-installed.mjs --package INSTALLED_BROKER --fixture CURRENT_FIXTURE --source-http-helper ABS --pi-package PI_PACKAGE_JSON --out NEW_ABSOLUTE_DIRECTORY';
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1];
  assert.ok(keys.includes(key) && value && isAbsolute(value) && !options.has(key), usage);
  options.set(key, resolve(value));
}
for (const key of keys) assert.ok(options.has(key), key + ' is required');
const packageRoot = await realpath(options.get('--package'));
const fixture = JSON.parse(await readFile(options.get('--fixture'), 'utf8'));
assert.equal(fixture.version, 2);
assert.equal(fixture.kind, 'current-notion-service');
assert.ok(fixture.expected.catalog_count > 0 && fixture.expected.file_count > 100);
assert.ok(!('snapshots' in fixture) && !('scope' in fixture), 'Only current service facts are accepted');
const hash = value => createHash('sha256').update(value).digest('hex');
const noWrites = { version: 1, remote_writes: 'none', author_content: 'unchanged' };
let out = options.get('--out');
async function inventory() {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(join(packageRoot, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'Installed runtime may not route to a checkout');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = await readFile(join(packageRoot, path));
        files.push({ path, bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  await walk('src'); await walk('dist');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

if (!worker) {
  await mkdir(out, { recursive: false, mode: 0o700 });
  out = await realpath(out);
  options.set('--out', out);
  const before = await inventory();
  const runtime = JSON.parse(await readFile(join(packageRoot, 'dist/ntn-skills-runtime.json'), 'utf8'));
  verifyBundledRuntime({ manifest: runtime, expectedVersion: runtime.package_version,
    cliBytes: await readFile(join(packageRoot, 'dist/ntn-skills.mjs')),
    sdkBytes: await readFile(join(packageRoot, 'dist/ntn-skills-sdk.mjs')),
    refBytes: await readFile(join(packageRoot, 'dist/ntn-skills-ref.cjs')) });
  const { startSdkSourceFixture } = await import(pathToFileURL(options.get('--source-http-helper')).href);
  const service = await startSdkSourceFixture(fixture, join(out, 'source.jsonl'));
  const fixtureEnv = JSON.parse(await readFile(fixture.env, 'utf8'));
  const env = {
    PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(out, 'home'), TMPDIR: out, LANG: 'en_US.UTF-8',
    XDG_CONFIG_HOME: join(out, 'xdg-config'), XDG_CACHE_HOME: join(out, 'xdg-cache'),
    XDG_DATA_HOME: join(out, 'xdg-data'), XDG_STATE_HOME: join(out, 'xdg-state'),
    NTN_SKILLS_HOME: join(out, 'state'), NTN_SKILLS_CONFIG_HOME: join(out, 'config'),
    NTN_SKILLS_CACHE_HOME: join(out, 'cache'), NTN_SKILLS_DATA_HOME: join(out, 'data'),
    NTN_SKILLS_NOTION_INTERVAL_MS: fixtureEnv.NTN_SKILLS_NOTION_INTERVAL_MS,
    NTN_SKILLS_REQUEST_TRACE_LIMIT: '10000', NOTION_API_TOKEN: fixtureEnv.NOTION_API_TOKEN,
    NOTION_API_BASE_URL: service.origin,
  };
  await mkdir(env.HOME, { mode: 0o700 });
  let result = { status: 'failed', error: 'NO_RESULT' };
  try {
    const child = childProcess.spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker',
      ...[...options].flat()], { cwd: out, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
    const exit = await new Promise((done, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
    });
    await writeFile(join(out, 'stdout.log'), Buffer.concat(stdout), { mode: 0o600 });
    await writeFile(join(out, 'stderr.log'), Buffer.concat(stderr), { mode: 0o600 });
    result = JSON.parse(await readFile(join(out, 'result.json'), 'utf8').catch(() => JSON.stringify(result)));
    assert.deepEqual(await inventory(), before, 'Verification may not alter installed product files');
    assert.equal(exit.code, 0, Buffer.concat(stderr).toString());
    assert.equal(result.status, 'passed');
    assert.deepEqual(service.unexpected, [], 'No undeclared reads or semantic writes are allowed');
    assert.ok(service.requests.every(call => call.method === 'GET'
      || call.method === 'POST' && /^\/v1\/data_sources\/[^/]+\/query$/.test(call.path)));
    const countQueries = id => service.requests.filter(call => call.path === '/v1/data_sources/' + id + '/query').length;
    assert.ok(countQueries(fixture.notion.library.files.data_source_id) >= 2, 'Files must page beyond 100 rows');
    if (fixture.expected.catalog_count > 100)
      assert.ok(countQueries(fixture.notion.library.skills.data_source_id) >= 2, 'Catalog must page beyond 100 rows');
    result = { ...result, runtime, package_unchanged: true, http_requests: service.requests.length,
      semantic_writes: 0, fixture: options.get('--fixture'),
      boundary: 'Actual independently installed Broker and SDK v3 against controlled current Notion HTTP.',
      not_run: ['Pi session', 'provider/model', 'live Notion', 'OMP', 'Tern'] };
    await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  } finally { await service.close(); }
  console.log(JSON.stringify({ ...result, evidence: out }));
} else {
  const sdkEvents = [], processEvents = [], results = [];
  const topic = channel('context-broker.notion-sdk');
  topic.subscribe(event => {
    sdkEvents.push(event); appendFileSync(join(out, 'sdk.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
  });
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    childProcess[name] = function(...values) {
      processEvents.push({ api: name, command: basename(String(values[0])) });
      return original.apply(this, values);
    };
  }
  syncBuiltinESMExports();
  // Pi supplies only the TypeScript loader here. No Pi session/provider is started.
  const { createJiti } = createRequire(options.get('--pi-package'))('jiti');
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
  const { discoverNotionSource, loadNotionSkill, prepareNotionSkills, loadNotionResource, readNotionResources, resolveNotionRelativeReference } =
    await jiti.import(join(packageRoot, 'src/notion-source.ts'));
  const { DEFAULT_RESOURCE_READ_BUDGET, normalizeResourceReadBudget } =
    await jiti.import(join(packageRoot, 'src/resource-read-types.ts'));
  const { parseNativeReference } = await jiti.import(join(packageRoot, 'src/native-reference.ts'));
  const source = { type: 'notion', id: 'current-sdk', namespace: 'current-sdk',
    library: fixture.notion.library.library_id, cacheDir: join(out, 'host-cache'), prefetch: false };
  let directory, selected, loaded;
  const expectedFile = path => {
    const file = fixture.expected.files.find(file => file.path === path);
    assert.ok(file, path); return file;
  };
  function verified(bytes, expected) {
    assert.equal(bytes.length, expected.bytes); assert.equal(hash(bytes), expected.sha256);
    assert.deepEqual(bytes, Buffer.from(expected.content, expected.encoding === 'base64' ? 'base64' : 'utf8'));
  }
  async function scenario(name, run) {
    const sdkBefore = sdkEvents.length, processesBefore = processEvents.length, started = performance.now();
    try {
      const details = await run();
      const events = sdkEvents.slice(sdkBefore), ended = events.filter(event => event.event === 'end');
      assert.equal(processEvents.length, processesBefore, 'Broker consumption must not spawn CLI children');
      assert.equal(events.filter(event => event.event === 'start').length, ended.length);
      results.push({ name, status: 'passed', elapsed_ms: performance.now() - started, sdk_calls: ended.length,
        requests: ended.map(event => event.request_metrics), child_starts: 0, ...details });
      await writeFile(join(out, 'progress.json'), JSON.stringify(results, null, 2) + '\n');
    } catch (error) {
      results.push({ name, status: 'failed', code: error.code ?? error.name, message: error.message });
      await writeFile(join(out, 'result.json'), JSON.stringify({ status: 'failed', cases: results }, null, 2) + '\n');
      throw error;
    }
  }
  await scenario('catalog-current-pagination', async () => {
    directory = await discoverNotionSource(source, out);
    assert.equal(directory.length, fixture.expected.catalog_count);
    assert.equal(directory.failures.length, 0);
    selected = directory.find(record => record.locator.page_id === fixture.root_page_id);
    assert.ok(selected); assert.equal(selected.body, undefined);
    return { catalog_count: directory.length };
  });
  await scenario('entry-current-complete-directory', async () => {
    const effects = [];
    loaded = await loadNotionSkill(selected, source, out, { observeEffects: value => effects.push(value) });
    verified(await readFile(loaded.path), expectedFile('SKILL.md'));
    assert.equal(loaded.body, expectedFile('SKILL.md').content);
    assert.equal(loaded.entryManifest.files.length, fixture.expected.file_count);
    assert.equal(loaded.fileBindings.length, fixture.expected.file_count);
    assert.deepEqual(loaded.entryManifest.files.map(file => file.path).sort(), fixture.expected.files.map(file => file.path).sort());
    assert.deepEqual(loaded.entryManifest.materialized_paths, ['SKILL.md']);
    assert.equal(loaded.entryManifest.local_files_ready, false);
    assert.ok(effects.length > 0); effects.forEach(value => assert.deepEqual(value, noWrites));
    return { file_count: loaded.entryManifest.files.length, snapshot: loaded.snapshotId };
  });
  await scenario('entry-warm-current-cache', async () => {
    const before = sdkEvents.length;
    const warm = await loadNotionSkill(selected, source, out);
    assert.equal(warm.snapshotId, loaded.snapshotId);
    verified(await readFile(warm.path), expectedFile('SKILL.md'));
    for (const event of sdkEvents.slice(before).filter(event => event.event === 'end')) {
      assert.equal(event.metrics_observed, true);
      assert.equal(event.request_metrics.requests.notion_body, 0);
      assert.equal(event.request_metrics.requests.notion_write, 0);
      assert.ok(event.request_metrics.total_requests <= 1, "Only the operation authentication check may repeat");
    }
  });
  await scenario('prepare-current-use', async () => {
    const graph = await prepareNotionSkills([selected], source, out, { purpose: 'use' });
    assert.equal(graph.records.length, 1); assert.deepEqual(graph.roots, [selected.id]);
    assert.deepEqual(graph.effects, noWrites);
    verified(await readFile(graph.records[0].path), expectedFile('SKILL.md'));
    assert.equal(graph.records[0].snapshotId, loaded.snapshotId);
  });
  await scenario('resolve-scalar-relative-reference', async () => {
    const before = sdkEvents.length, effects = [];
    for (const [containing, relative, targetPath] of [
      ['SKILL.md', 'references/guide.txt', 'references/guide.txt'],
      ['references/guide.txt', '../SKILL.md', 'SKILL.md'],
    ]) {
      const from = loaded.entryManifest.files.find(file => file.path === containing).ref;
      const ref = await resolveNotionRelativeReference(loaded, from, relative, source, out, undefined,
        { observeEffects: value => effects.push(value) });
      const target = parseNativeReference(ref);
      assert.equal(target.selector, loaded.id);
      assert.equal(target.path, targetPath);
      assert.equal(target.snapshot, loaded.snapshotId);
    }
    assert.equal(effects.length, 2); effects.forEach(value => assert.deepEqual(value, noWrites));
    for (const event of sdkEvents.slice(before).filter(event => event.event === 'end')) {
      assert.equal(event.operation, 'resolve');
      assert.equal(event.metrics_observed, true);
      assert.equal(event.request_metrics.requests.notion_body, 0);
      assert.equal(event.request_metrics.requests.notion_write, 0);
      assert.equal(event.request_metrics.requests.provider, 0);
    }
    assert.deepEqual(loaded.entryManifest.materialized_paths, ['SKILL.md']);
  });
  await scenario('read-scalar-resource', async () => {
    const effects = [];
    const path = await loadNotionResource(loaded, 'references/guide.txt', source, out, undefined,
      { observeEffects: value => effects.push(value) });
    verified(await readFile(path), expectedFile('references/guide.txt'));
    assert.ok(effects.length > 0); effects.forEach(value => assert.deepEqual(value, noWrites));
    assert.equal(loaded.entryManifest.local_files_ready, false);
  });
  await scenario('read-resource-batch', async () => {
    const paths = ['references/guide.txt', 'assets/raw.bin'];
    const refs = paths.map(path => loaded.entryManifest.files.find(file => file.path === path).ref);
    const budgets = [DEFAULT_RESOURCE_READ_BUDGET, normalizeResourceReadBudget({ timeBudgetMs: 120_000 })];
    assert.deepEqual(budgets, [
      { maxFiles: 16, maxBytes: 1024 * 1024, timeBudgetMs: 30_000 },
      { maxFiles: 16, maxBytes: 1024 * 1024, timeBudgetMs: 120_000 },
    ]);
    for (const budget of budgets) {
      const batch = await readNotionResources(loaded, refs, budget, source, out);
      assert.deepEqual(batch.effects, noWrites);
      assert.deepEqual(batch.budget, budget);
      assert.deepEqual(batch.files.map(file => file.path), paths);
      for (const file of batch.files) {
        verified(Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'), expectedFile(file.path));
        if (file.encoding === 'base64') verified(await readFile(file.output), expectedFile(file.path));
      }
    }
    return { budgets };
  });
  await scenario('reject-wrong-scope', async () => {
    await assert.rejects(prepareNotionSkills([{ ...selected, sourceScope: 'f'.repeat(64) }], source, out,
      { purpose: 'use' }), { code: 'SOURCE_PREPARATION_INVALID' });
  });
  await scenario('reject-wrong-physical-owner', async () => {
    await assert.rejects(prepareNotionSkills([{ ...selected, locator: { ...selected.locator,
      page_id: directory.find(record => record.id !== selected.id)?.locator.page_id ?? fixture.notion.files[0].id } }], source, out,
      { purpose: 'use' }), { code: 'SOURCE_PREPARATION_INVALID' });
  });
  await scenario('cancel-before-sdk', async () => {
    const controller = new AbortController(); controller.abort();
    const before = sdkEvents.length;
    await assert.rejects(prepareNotionSkills([selected], source, out,
      { purpose: 'use', signal: controller.signal }), { code: 'SOURCE_CANCELLED' });
    assert.equal(sdkEvents.length, before);
  });
  await scenario('cancel-before-materialization', async () => {
    const controller = new AbortController(), cacheDir = join(out, 'cancelled-host-cache');
    const cancel = event => { if (event.event === 'end' && event.operation === 'consume') controller.abort(); };
    topic.subscribe(cancel);
    try {
      await assert.rejects(prepareNotionSkills([selected], { ...source, cacheDir }, out,
        { purpose: 'use', signal: controller.signal }), { code: 'SOURCE_CANCELLED' });
      await assert.rejects(readdir(cacheDir), { code: 'ENOENT' });
    } finally { topic.unsubscribe(cancel); }
  });
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: 'passed', node: process.version,
    cases: results, sdk_calls: sdkEvents.filter(event => event.event === 'start').length, child_starts: processEvents.length }, null, 2) + '\n');
}
