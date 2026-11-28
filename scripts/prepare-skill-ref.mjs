import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read only the pure artifact exported by this already selected CLI package. */
export async function selectedSkillRef(packageRoot) {
  const root = await realpath(packageRoot), metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'ntn-skills');
  const entry = metadata.exports?.['./ref']?.require;
  assert.ok(typeof entry === 'string' && entry.startsWith('./'), 'The selected CLI must export ntn-skills/ref as CJS');
  const path = await realpath(resolve(root, entry)), within = relative(root, path);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'The pure reference module must belong to the selected CLI');
  const bytes = await readFile(path), api = createRequire(join(root, 'package.json'))(path);
  assert.equal(api.SKILL_REF_VERSION, 2, 'The selected pure reference contract must be version 2');
  for (const name of ['createSkillKey', 'parseSkillRef', 'bindSkillRef', 'formatSkillRef', 'formatSkillIdentity',
    'parseSkillIdentity', 'sameSkillKey', 'normalizeSkillPath', 'skillRefPath', 'skillRefSnapshot'])
    assert.equal(typeof api[name], 'function', 'The selected reference protocol must export ' + name);
  return { bytes, path, package_version: metadata.version, skill_ref_version: 2,
    ref_sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Source tests copy real selected bytes into their own writable run tree. */
export async function prepareSkillRef(cliEntry, output) {
  assert.ok(isAbsolute(cliEntry) && isAbsolute(output), 'Select absolute CLI and owned output paths');
  let root = dirname(await realpath(cliEntry));
  while (true) {
    const metadata = await readFile(join(root, 'package.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (metadata?.name === 'ntn-skills') break;
    const parent = dirname(root); assert.notEqual(parent, root, 'Selected CLI package is missing'); root = parent;
  }
  const selected = await selectedSkillRef(root);
  await mkdir(output, { recursive: true });
  const manifestPath = join(output, 'ntn-skills-runtime.json');
  const previous = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
  await writeFile(join(output, 'ntn-skills-ref.cjs'), selected.bytes);
  await writeFile(manifestPath, JSON.stringify({ ...previous, version: 1, package: 'ntn-skills',
    package_version: selected.package_version, skill_ref_version: 2, ref_sha256: selected.ref_sha256 }, null, 2) + '\n');
  return { path: join(output, 'ntn-skills-ref.cjs'), source: selected.path, ref_sha256: selected.ref_sha256, skill_ref_version: 2 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cliEntry = process.env.NTN_SKILLS_BUILD_ENTRY;
  assert.ok(cliEntry, 'Set NTN_SKILLS_BUILD_ENTRY to the selected packaged CLI before source tests');
  const output = resolve(process.argv[2] ?? 'packages/context-broker/dist');
  console.log(JSON.stringify(await prepareSkillRef(resolve(cliEntry), output)));
}
