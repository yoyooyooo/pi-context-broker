import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCorpus, sealCorpus } from './corpus/index.mjs';
import { readCorpusSnapshot } from './corpus/snapshot.mjs';
import { buildStoreDiagnosticCorpus, STORE_FIRST_USE_GENERATOR, buildLongSessionDiagnosticCorpus, LONG_SESSION_GENERATOR } from './diagnostic-corpus.mjs';
import { configureComparison } from './configure.mjs';
import { executionImplementation } from './implementation.mjs';
import { planBenchmarkFixture } from './fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(corpus = buildStoreDiagnosticCorpus({ seed: 'snapshot-identity' })) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'benchmark-corpus-snapshot-')));
  const path = join(root, 'snapshot.json'), bytes = JSON.stringify(corpus, null, 2) + '\n';
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  const setup = { version: 1, environment_root: root, control_root: join(root, 'scope'),
    candidates: [{}, {}], budget: {}, decision: {}, models: {},
    corpus: { seed: corpus.publicCorpus.seed, split: corpus.publicCorpus.split, material_version: corpus.publicCorpus.version,
      ...(corpus.publicCorpus.provenance.generator ? { generator: corpus.publicCorpus.provenance.generator } : {}),
      snapshot: { path, sha256: sha(bytes) } } };
  return { root, corpus, setup };
}

test('a frozen full snapshot preserves every canary, oracle and public byte across reads', async () => {
  const { corpus, setup } = await fixture();
  assert.deepEqual(await readCorpusSnapshot(setup), corpus);
  assert.deepEqual(await readCorpusSnapshot(setup), corpus);
  assert.equal(sha(await readFile(setup.corpus.snapshot.path)), setup.corpus.snapshot.sha256);
  assert.notDeepEqual(buildStoreDiagnosticCorpus({ seed: setup.corpus.seed }).control.canaries, corpus.control.canaries);
  assert.equal(await readCorpusSnapshot({ corpus: {} }), null, 'Omitted snapshots preserve the existing generation path');
});

test('long-session snapshots keep their declared generator and exact eight-turn private control', async () => {
  const { corpus, setup } = await fixture(buildLongSessionDiagnosticCorpus({ seed: 'long-session-snapshot' }));
  assert.equal(setup.corpus.generator, LONG_SESSION_GENERATOR);
  assert.deepEqual(await readCorpusSnapshot(setup), corpus);
  assert.ok(corpus.publicCorpus.cases.every(item => item.turns.length === 8 && item.attachments.length === 0));
  await assert.rejects(readCorpusSnapshot({ ...setup, corpus: { ...setup.corpus, generator: STORE_FIRST_USE_GENERATOR } }), /generator differs/);
  await assert.rejects(readCorpusSnapshot({ ...setup, corpus: { ...setup.corpus, split: 'confirmation' } }), /development/);
  await assert.rejects(readCorpusSnapshot({ ...setup, corpus: { ...setup.corpus, material_version: '1' } }));
});

test('snapshot loading preserves generator, seed, split and material-version boundaries', async () => {
  const { setup } = await fixture();
  for (const change of [
    { seed: '' }, { seed: 'different' }, { split: 'not-a-split' }, { material_version: '3' },
    { generator: 'unknown' }, { split: 'pilot' }, { material_version: '1' },
  ]) await assert.rejects(readCorpusSnapshot({ ...setup, corpus: { ...setup.corpus, ...change } }));
  const ordinary = await fixture(buildCorpus({ seed: 'ordinary', materialVersion: '2' }));
  await assert.rejects(readCorpusSnapshot({ ...ordinary.setup, corpus: { ...ordinary.setup.corpus, generator: STORE_FIRST_USE_GENERATOR } }), /generator differs/);
  const otherSplit = { ...ordinary.setup.corpus, split: 'pilot' };
  await assert.rejects(readCorpusSnapshot({ ...ordinary.setup, corpus: otherSplit }), /split differs/);
  await assert.rejects(readCorpusSnapshot({ ...ordinary.setup, corpus: { ...ordinary.setup.corpus, material_version: '1' } }), /version differs/);
});

test('snapshot input is exclusive, private, regular and bound to its exact file bytes', async () => {
  const { setup, root } = await fixture(), reference = setup.corpus.snapshot;
  await assert.rejects(readCorpusSnapshot({ ...setup, materialization_binding_file: '/retained/binding.json' }), /cannot also select/);
  for (const changed of [null, { ...reference, extra: true }, { ...reference, path: 'relative.json' }, { ...reference, sha256: '0'.repeat(64) }])
    await assert.rejects(readCorpusSnapshot({ ...setup, corpus: { ...setup.corpus, snapshot: changed } }));
  const linked = join(root, 'linked.json'); await symlink(reference.path, linked);
  await assert.rejects(readCorpusSnapshot({ ...setup, corpus: { ...setup.corpus, snapshot: { ...reference, path: linked } } }), /symlink/);
  await assert.rejects(readCorpusSnapshot({ ...setup, control_root: root }), /outside repository, configuration and subject roots/);
  await writeFile(reference.path, (await readFile(reference.path, 'utf8')) + ' ');
  await assert.rejects(readCorpusSnapshot(setup), /bytes changed/);
});

test('a matching outer hash cannot admit missing private control or invalid corpus content', async () => {
  const original = buildStoreDiagnosticCorpus({ seed: 'snapshot-invalid-content' });
  for (const change of [
    corpus => { delete corpus.control; },
    corpus => { corpus.control.canaries = []; },
    corpus => { delete corpus.control.seal; },
    corpus => { corpus.publicCorpus.skills[0].versions.v1.files[0].content += 'changed'; },
    corpus => { corpus.control.cases[0].oracles['4'].public_sha256 = '0'.repeat(64); },
  ]) {
    const corpus = structuredClone(original); change(corpus);
    const { setup } = await fixture(corpus);
    await assert.rejects(readCorpusSnapshot(setup));
  }
});

test('loading a sealed snapshot preserves its seal and cannot authorize fixture preparation', async () => {
  const corpus = sealCorpus({ corpus: buildCorpus({ seed: 'snapshot-confirmation', split: 'confirmation', materialVersion: '2' }), sealedAt: '2026-11-23T00:00:00Z' });
  const { setup, root } = await fixture(corpus), loaded = await readCorpusSnapshot(setup);
  assert.deepEqual(loaded.control.seal, corpus.control.seal);
  assert.throws(() => planBenchmarkFixture({ corpus: loaded, caseIds: ['explicit-01-a'], scopeId: 'sealed-snapshot',
    controlRoot: setup.control_root, projectPageId: '11111111-1111-4111-8111-111111111111', buildRoot: join(root, 'builds/test'), node: process.execPath }), /remains sealed/);
});

test('configure rejects conflicting or changed snapshots before retaining a setup or performing any capture', async () => {
  const { setup } = await fixture();
  await assert.rejects(configureComparison({ ...setup, materialization_binding_file: '/retained/binding.json' }), /cannot also select/);
  await assert.rejects(lstat(setup.control_root), { code: 'ENOENT' });
  await assert.rejects(configureComparison({ ...setup, corpus: { ...setup.corpus, snapshot: { ...setup.corpus.snapshot, sha256: '0'.repeat(64) } } }), /bytes changed/);
  await assert.rejects(lstat(setup.control_root), { code: 'ENOENT' });
});

test('the actual controller identity includes configure, snapshot loading and shared authoring dependencies', async () => {
  const actual = await executionImplementation();
  for (const path of ['configure.mjs', 'corpus/snapshot.mjs', '../scripts/notion-agent-authoring.mjs']) {
    const file = actual.files.find(file => file.path === path); assert.ok(file, 'Missing controller dependency: ' + path);
    assert.equal(file.sha256, sha(await readFile(new URL(path, import.meta.url))));
  }
});
