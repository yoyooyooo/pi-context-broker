import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyTurnRuntimeBuild, runSubject } from './execute.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['subject.mjs', 'turn-bridge.mjs', 'runtime/episode-runner.mjs', 'runtime/episode-visibility.mjs'];
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
    assert.equal(proof.status, 'verified'); assert.equal(proof.files.length, 4); assert.equal(proof.command_source, 'none');
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

test('new single-turn dispatch also requires a current frozen runtime-only subject', async () => {
  const f = await fixture();
  const proof = await verifyTurnRuntimeBuild({ ...f,
    binding: { public_case: { turns: [{ id: 'turn-1' }] }, events: [], clarification: [] } });
  assert.equal(proof.status, 'verified'); assert.equal(proof.required, true); assert.equal(proof.files.length, 4);
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

test('an old or incomplete subject fails before credentials, control directories and dispatch, including one-turn work', async () => {
  for (const captureOnly of [true, false]) for (const turns of [1, 2]) {
    const f = await fixture(); let credentialReads = 0, dispatches = 0;
    f.binding = { public_case: { turns: binding.public_case.turns.slice(0, turns) } };
    await writeFile(join(f.buildRoot, 'source/broker/benchmark/subject.mjs'), '// old wrapper\n');
    await assert.rejects(runSubject({ ...f, mode: 'native', modelsFile: join(f.environmentRoot, 'models-not-read.json'),
      controlRoot: join(f.environmentRoot, 'control-not-created'), runId: 'no-dispatch', captureOnly,
      credential: { source_file: '/never-read', provider: 'no-provider', api_key_env: 'NO_PROVIDER_KEY' } }, {
      resolveModelCredential: async () => { credentialReads++; throw new Error('Credential must not be read'); },
      runEnvironment: async () => { dispatches++; throw new Error('Subject must not be dispatched'); },
    }), { code: 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH' });
    assert.equal(credentialReads, 0); assert.equal(dispatches, 0);
    await assert.rejects(lstat(join(f.environmentRoot, 'control-not-created')), { code: 'ENOENT' });
    await rename(join(f.buildRoot, 'build.json'), join(f.buildRoot, 'build-retained.json'));
    await assert.rejects(verifyTurnRuntimeBuild(f), { code: 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH' });
  }
});


test('ordinary-derived dispatch also freezes the resource reader, finite tool policy and credential recorder', async () => {
  const f = await fixture(), manifestPath = join(f.buildRoot, 'build.json');
  const resourceProfile = { path: join(f.environmentRoot, 'profile-not-read-by-build-gate.json'), sha256: 'f'.repeat(64) };
  await assert.rejects(verifyTurnRuntimeBuild({ ...f, resourceProfile }), { code: 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH' });
  const extra = ['scripts/paired-resource-profile.mjs', 'benchmark/runtime/episode-policy.mjs', 'benchmark/runtime/episode-evidence.mjs'];
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const path of extra) {
    const bytes = await readFile(new URL('../' + path, import.meta.url)), target = join(f.buildRoot, 'source/broker', path);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
    manifest.source_tree.files.push({ path: 'broker/' + path, sha256: hash(bytes) });
  }
  manifest.source_tree.sha256 = hash(JSON.stringify(manifest.source_tree.files)); await writeFile(manifestPath, JSON.stringify(manifest));
  const proof = await verifyTurnRuntimeBuild({ ...f, resourceProfile }); assert.equal(proof.files.length, 7);
  for (const path of extra) assert.ok(proof.files.some(file => file.path === path));
  await writeFile(join(f.buildRoot, 'source/broker/scripts/paired-resource-profile.mjs'), 'older profile implementation');
  await assert.rejects(verifyTurnRuntimeBuild({ ...f, resourceProfile }), { code: 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH' });
});


test('dispatch rejects explicit empty profiles before build verification, credential reads or child processes', async () => {
  const f = await fixture(); let operations = 0;
  for (const resourceProfile of [null, false, '']) {
    await assert.rejects(verifyTurnRuntimeBuild({ ...f, resourceProfile }), error => error.code === 'BENCHMARK_TURN_RUNTIME_BUILD_MISMATCH' && /RESOURCE_PROFILE_REFERENCE_REQUIRED/.test(error.details.reason));
    await assert.rejects(runSubject({ ...f, mode: 'broker', resourceProfile, modelsFile: join(f.environmentRoot, 'never-read-models.json'),
      controlRoot: join(f.environmentRoot, 'never-created-control'), runId: 'no-dispatch', captureOnly: true }, {
      verifyTurnRuntimeBuild() { operations++; throw new Error('No build verification'); },
      resolveModelCredential() { operations++; throw new Error('No credential access'); },
      runEnvironment() { operations++; throw new Error('No child process'); },
    }), /RESOURCE_PROFILE_REFERENCE_REQUIRED/);
  }
  assert.equal(operations, 0); await assert.rejects(lstat(join(f.environmentRoot, 'never-created-control')), { code: 'ENOENT' });
});
