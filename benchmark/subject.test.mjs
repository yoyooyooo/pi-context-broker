import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { prepareSkillRef } from '../scripts/prepare-skill-ref.mjs';
import { executionImplementation } from './implementation.mjs';
import { projectSubjectRuntime } from './subject.mjs';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('the public subject projection imports with its real paired SDK3 reference protocol and excludes private material', async t => {
  assert.ok(process.env.NTN_SKILLS_BUILD_ENTRY, 'Subject projection regressions require the selected built CLI/SDK');
  const root = await mkdtemp(join(tmpdir(), 'benchmark-subject-sdk3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const buildRoot = join(root, 'build'), origin = join(buildRoot, 'source/broker');
  for (const file of (await executionImplementation()).files) {
    const path = join('benchmark', file.path);
    await mkdir(dirname(join(origin, path)), { recursive: true });
    await cp(join(repository, path), join(origin, path));
  }
  await mkdir(join(origin, 'benchmark/runtime'), { recursive: true });
  for (const name of await readdir(join(repository, 'benchmark/runtime')))
    if (/^episode-.*\.mjs$/.test(name) && !name.endsWith('.test.mjs'))
      await cp(join(repository, 'benchmark/runtime', name), join(origin, 'benchmark/runtime', name));
  const selectedSdk = join(dirname(process.env.NTN_SKILLS_BUILD_ENTRY), 'sdk.js');
  const sdk = await import(pathToFileURL(selectedSdk).href);
  assert.equal(sdk.SDK_VERSION, 3);
  await mkdir(join(buildRoot, 'cli/dist'), { recursive: true });
  await cp(selectedSdk, join(buildRoot, 'cli/dist/sdk.js'));
  const packaged = join(buildRoot, 'broker/dist');
  await prepareSkillRef(process.env.NTN_SKILLS_BUILD_ENTRY, packaged);
  await cp(join(packaged, 'ntn-skills-ref.cjs'), join(buildRoot, 'cli/dist/ref.cjs'));
  await cp(selectedSdk, join(packaged, 'ntn-skills-sdk.mjs'));
  const manifestPath = join(packaged, 'ntn-skills-runtime.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, sdk_version: sdk.SDK_VERSION, sdk_sha256: sha(await readFile(selectedSdk)) }));
  const projectionRoot = join(root, 'subject-runtime');
  const inventory = await projectSubjectRuntime({ buildRoot, projectionRoot });
  await import(pathToFileURL(join(projectionRoot, 'benchmark/runtime/episode-runner.mjs')).href);
  const refs = await import(pathToFileURL(join(projectionRoot, 'packages/context-broker/src/native-reference.ts')).href);
  const owner = refs.nativeSkillId('4215636c-236e-81e8-8168-ee2ac696f73a', 'projection-proof');
  const snapshot = 's_' + sha('projection-proof');
  assert.deepEqual(refs.parseNativeReference(refs.nativeFileRef(owner, 'references/example.md', snapshot)),
    { selector: owner, path: 'references/example.md', snapshot });
  assert.ok(inventory.some(file => file.path.endsWith('/ntn-skills-ref.cjs') && file.sha256 === manifest.ref_sha256));
  assert.ok(inventory.some(file => file.path === 'scripts/notion-agent-inventory-evidence.mjs'));
  assert.ok(!inventory.some(file => /fixture|corpus|grader|oracle|\.test\./.test(file.path)));
  await writeFile(join(packaged, 'ntn-skills-sdk.mjs'), 'different paired SDK');
  await assert.rejects(projectSubjectRuntime({ buildRoot, projectionRoot: join(root, 'mismatched-runtime') }), /paired SDK/);
});
