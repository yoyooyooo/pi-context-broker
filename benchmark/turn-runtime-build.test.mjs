import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyTurnRuntimeBuild, runSubject } from './execute.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['subject.mjs', 'turn-bridge.mjs', 'runtime/episode-runner.mjs'];
const binding = { public_case: { turns: [{ id: 'turn-1', prompt: 'Read.' }, { id: 'turn-2', prompt: 'Continue.' }] } };
async function fixture() {
  const environmentRoot = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-turn-runtime-build-'))), buildId = 'owned-build';
  const buildRoot = join(environmentRoot, 'builds', buildId), files = [];
  await writeFile(join(environmentRoot, 'environment.json'), JSON.stringify({ kind: 'paired-development-environment',
    root: environmentRoot, environment_id: 'owned-apparatus-environment' }), { flag: 'wx' });
  for (const name of names) {
    const bytes = await readFile(new URL('./' + name, import.meta.url));
    const path = join(buildRoot, 'source/broker/benchmark', name);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx' });
    files.push({ path: 'broker/benchmark/' + name, sha256: hash(bytes) });
  }
  const packageFiles = [{ path: 'package.json', sha256: hash('synthetic product metadata only'), executable: false }];
  const product = { files: packageFiles, sha256: hash(JSON.stringify(packageFiles)) };
  await writeFile(join(buildRoot, 'build.json'), JSON.stringify({ version: 1, kind: 'paired-build', root: buildRoot,
    environment_id: 'owned-apparatus-environment', build_id: buildId, selected_cli_sha256: 'a'.repeat(64),
    source_tree: { files, sha256: hash(JSON.stringify(files)) }, packages: { cli: product, broker: product } }) + '\n', { flag: 'wx' });
  return { environmentRoot, buildRoot, buildId, binding };
}

test('every declared turn-control feature requires the current frozen common runtime', async () => {
  const f = await fixture();
  for (const current of [binding, { public_case: { turns: [{ id: 'turn-1' }] }, events: [{ id: 'policy-v2' }] },
    { public_case: { turns: [{ id: 'turn-1' }] }, clarification: [{ topic_id: 'delivery-mode' }] }]) {
    const proof = await verifyTurnRuntimeBuild({ ...f, binding: current });
    assert.equal(proof.status, 'verified'); assert.equal(proof.files.length, 3);
    assert.ok(proof.files.every(file => file.current.sha256 === file.build.sha256 && file.build.sha256 === file.frozen_sha256));
  }
});

test('a large legal source inventory passes both build reads while source and environment limits stay narrow', async () => {
  const f = await fixture(), path = join(f.buildRoot, 'build.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.source_tree.files.push(...Array.from({ length: 90000 }, (_, index) => ({
    path: 'broker/node_modules/' + index + '/' + 'nested-package-'.repeat(8) + '/entry.js', sha256: 'b'.repeat(64), executable: false,
  })));
  manifest.source_tree.sha256 = hash(JSON.stringify(manifest.source_tree.files));
  const bytes = Buffer.from(JSON.stringify(manifest));
  assert.ok(bytes.length > 16 * 1024 * 1024 && bytes.length < 64 * 1024 * 1024);
  await writeFile(path, bytes);
  const proof = await verifyTurnRuntimeBuild(f);
  assert.equal(proof.status, 'verified'); assert.equal(proof.build.bytes, bytes.length); assert.equal(proof.build.sha256, hash(bytes));
  for (const target of [join(f.environmentRoot, 'environment.json'), join(f.buildRoot, 'source/broker/benchmark/subject.mjs')]) {
    const previous = await readFile(target);
    await writeFile(target, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
    await assert.rejects(verifyTurnRuntimeBuild(f), error => error.code === 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH'
      && error.details.reason === 'TURN_RUNTIME_ORDINARY_FILE');
    await writeFile(target, previous);
  }
  await writeFile(path, Buffer.alloc(64 * 1024 * 1024 + 1, 32));
  await assert.rejects(verifyTurnRuntimeBuild(f), error => error.code === 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH'
    && error.details.reason === 'TURN_RUNTIME_ORDINARY_FILE');
});

test('historical single-turn work does not acquire a new turn-runtime requirement', async () => {
  const proof = await verifyTurnRuntimeBuild({ environmentRoot: await realpath(tmpdir()), buildId: 'not-read',
    binding: { public_case: { turns: [{ id: 'turn-1' }] }, events: [], clarification: [] } });
  assert.equal(proof.status, 'not_required'); assert.deepEqual(proof.files, []);
});

test('changed or missing subject, bridge and episode runner cannot pass via a fresh manifest', async () => {
  for (const name of names) {
    const f = await fixture(), path = join(f.buildRoot, 'source/broker/benchmark', name);
    const previous = await readFile(path), changed = Buffer.concat([previous, Buffer.from('\n// different frozen helper\n')]);
    await writeFile(path, changed);
    const manifestFile = join(f.buildRoot, 'build.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.source_tree.files.find(file => file.path === 'broker/benchmark/' + name).sha256 = hash(changed);
    manifest.source_tree.sha256 = hash(JSON.stringify(manifest.source_tree.files));
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(verifyTurnRuntimeBuild(f), error => error.code === 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH' && /INSTRUMENTATION_MISMATCH/.test(error.details.reason));
    await rename(path, path + '.retained');
    await assert.rejects(verifyTurnRuntimeBuild(f), { code: 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH' });
  }
});

test('a partial or foreign build receipt cannot authorize fixture preparation', async () => {
  for (const change of [value => { value.kind = 'failed-build'; }, value => { value.environment_id = 'another-environment'; },
    value => { delete value.selected_cli_sha256; }, value => { delete value.packages.broker; }]) {
    const f = await fixture(), path = join(f.buildRoot, 'build.json'), value = JSON.parse(await readFile(path, 'utf8'));
    change(value); await writeFile(path, JSON.stringify(value));
    await assert.rejects(verifyTurnRuntimeBuild(f), { code: 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH' });
  }
});

test('an incomplete build or bytes no longer matching its frozen manifest fail before credentials and dispatch', async () => {
  for (const captureOnly of [true, false]) {
    const f = await fixture(); let credentialReads = 0, dispatches = 0;
    await writeFile(join(f.buildRoot, 'source/broker/benchmark/subject.mjs'), '// old wrapper\n');
    await assert.rejects(runSubject({ ...f, mode: 'native', modelsFile: join(f.environmentRoot, 'models-not-read.json'),
      controlRoot: join(f.environmentRoot, 'control-not-created'), runId: 'no-dispatch', captureOnly,
      credential: { source_file: '/never-read', provider: 'no-provider', api_key_env: 'NO_PROVIDER_KEY' } }, {
      resolveModelCredential: async () => { credentialReads++; throw new Error('Credential must not be read'); },
      runEnvironment: async () => { dispatches++; throw new Error('Subject must not be dispatched'); },
    }), { code: 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH' });
    assert.equal(credentialReads, 0); assert.equal(dispatches, 0);
    await rename(join(f.buildRoot, 'build.json'), join(f.buildRoot, 'build-retained.json'));
    await assert.rejects(verifyTurnRuntimeBuild(f), { code: 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH' });
  }
});
