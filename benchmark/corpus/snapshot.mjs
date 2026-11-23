import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCorpus } from './index.mjs';
import { STORE_FIRST_USE_GENERATOR } from '../diagnostic-corpus.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const inside = (root, path) => { const child = relative(root, path); return child === '' || child !== '..' && !child.startsWith('../') && !isAbsolute(child); };

/** Read one complete private corpus without regenerating its canaries or oracles. */
export async function readCorpusSnapshot(setup) {
  const settings = setup.corpus, reference = settings.snapshot;
  if (reference === undefined) return null;
  assert.equal(setup.materialization_binding_file, undefined, 'A corpus snapshot cannot also select a shared materialization binding');
  assert.ok(reference && typeof reference === 'object' && !Array.isArray(reference), 'Corpus snapshot requires a path and byte SHA-256');
  assert.deepEqual(Object.keys(reference).sort(), ['path', 'sha256']);
  assert.ok(typeof reference.path === 'string' && isAbsolute(reference.path), 'Corpus snapshot path must be absolute');
  assert.match(reference.sha256, /^[a-f0-9]{64}$/u, 'Corpus snapshot requires a byte SHA-256');
  assert.equal(typeof settings.seed, 'string', 'An explicit corpus seed is required');
  assert.ok(settings.seed.trim(), 'Corpus seed must not be empty');
  assert.ok(['development', 'pilot', 'confirmation'].includes(settings.split), 'Unsupported corpus split');
  assert.ok(['1', '2'].includes(settings.material_version), 'Unknown synthetic material version');
  if (settings.generator !== undefined) {
    assert.equal(settings.generator, STORE_FIRST_USE_GENERATOR, 'Unknown explicit corpus generator');
    assert.equal(settings.split, 'development', 'Store diagnostics use separately declared development material');
    assert.equal(settings.material_version, '2');
  }
  for (const root of [repository, setup.control_root, join(setup.environment_root, 'builds'), join(setup.environment_root, 'runs')])
    assert.ok(!inside(root, reference.path), 'Corpus snapshot must remain outside repository, configuration and subject roots');
  assert.equal(await realpath(reference.path), reference.path, 'Corpus snapshot cannot traverse a symlink');
  const stat = await lstat(reference.path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024, 'Corpus snapshot must be one bounded regular file');
  const bytes = await readFile(reference.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256, 'Corpus snapshot bytes changed');
  const corpus = JSON.parse(bytes);
  assert.ok(corpus && typeof corpus === 'object' && !Array.isArray(corpus));
  assert.deepEqual(Object.keys(corpus).sort(), ['control', 'publicCorpus'], 'Corpus snapshot must contain the complete public and private control values');
  assert.ok(corpus.publicCorpus && corpus.control, 'Corpus snapshot requires private control');
  assert.ok(Array.isArray(corpus.control.canaries) && corpus.control.canaries.length > 0, 'Corpus snapshot requires the private visibility canaries');
  assert.ok(corpus.control.canaries.every(canary => typeof canary.id === 'string' && canary.id && typeof canary.value === 'string' && canary.value));
  assert.equal(corpus.control.seal?.split, corpus.publicCorpus.split, 'Corpus snapshot requires its original seal declaration');
  assert.ok((corpus.publicCorpus.split === 'confirmation' ? ['unsealed', 'sealed', 'opened'] : ['development']).includes(corpus.control.seal.state), 'Corpus snapshot has an unsupported seal state');
  validateCorpus(corpus);
  assert.equal(corpus.publicCorpus.seed, settings.seed, 'Corpus snapshot seed differs from setup');
  assert.equal(corpus.publicCorpus.split, settings.split, 'Corpus snapshot split differs from setup');
  assert.equal(corpus.publicCorpus.version, settings.material_version, 'Corpus snapshot version differs from setup');
  if (settings.generator !== undefined) assert.equal(corpus.publicCorpus.provenance.generator, settings.generator, 'Corpus snapshot generator differs from setup');
  return corpus;
}
