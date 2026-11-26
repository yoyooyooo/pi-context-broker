import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './protocol.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const files = ['implementation.mjs', 'revision.mjs', 'cli.mjs', 'configure.mjs', 'controller.mjs', 'batch.mjs', 'gate.mjs', 'collect.mjs',
  'subject.mjs', 'turn-bridge.mjs', 'fixture-turn-adapter.mjs',
  'execute.mjs', 'models.mjs', 'protocol.mjs', 'resumption.mjs', 'corpus/index.mjs', 'corpus/materials.mjs', 'corpus/grader.mjs',
  'evidence/normalize.mjs', 'evidence/store.mjs', 'schemas/protocol.schema.json',
  'schemas/environment-manifest.schema.json', 'metrics.json', '../scripts/paired-environment.mjs',
  '../scripts/notion-default-context.mjs', '../scripts/notion-integration-hosts.mjs',
  '../scripts/notion-skill-graph-model-evidence.mjs', '../scripts/skill-consumption-provider.mjs',
  '../scripts/skill-consumption-source-observer.mjs', '../scripts/skill-preparation-evidence.mjs',
  '../packages/context-broker/src/skill-ref-protocol.ts'];

// Ignore generated-program strings and comments when following static imports.
// A regex over the whole file would falsely treat bundled replay templates as
// dependencies of the controller executing this module.
function relativeImports(source) {
  const paths = [];
  for (let i = 0; i < source.length;) {
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (['\"', "'", '`'].includes(source[i])) {
      const quote = source[i++];
      while (i < source.length) { if (source[i] === '\\') i += 2; else if (source[i++] === quote) break; }
      continue;
    }
    if ((i === 0 || !/[\w$]/.test(source[i - 1])) && /[ie]/.test(source[i])) {
      const rest = source.slice(i), declaration = rest.match(/^(?:import\s+(?!\s*\()|export\s+(?=[{*]))(?:(?:[^;]+?)\s+from\s+)?['\"](\.[^'\"]+)['\"]/);
      if (declaration) { paths.push(declaration[1]); i += declaration[0].length; continue; }
    }
    i++;
  }
  return paths;
}

export async function executionImplementation() {
  const seen = new Map();
  async function visit(path) {
    if (seen.has(path)) return;
    const absolute = join(root, path), repoPath = relative(dirname(root), absolute);
    assert.ok(repoPath && !repoPath.startsWith('..'), 'Controller dependencies must stay in the repository');
    const bytes = await readFile(absolute);
    seen.set(path, { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    if (!path.endsWith('.mjs')) return;
    for (const dependency of relativeImports(bytes.toString('utf8')))
      await visit(relative(root, fileURLToPath(new URL(dependency, new URL(path, import.meta.url)))));
  }
  for (const path of files) await visit(path);
  const inventory = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, scope: 'controller-and-collector-source; subject runtime is bound by its paired build',
    files: inventory, sha256: fingerprint(inventory) };
}

export async function verifyExecutionImplementation(expected) {
  assert.ok(expected, 'The frozen plan must identify the executing controller and collector');
  assert.deepEqual(await executionImplementation(), expected, 'Controller or collector changed after preregistration; use a new identity');
}

export async function instrumentationIdentity(execution) {
  const observations = [];
  for (const condition of Object.values(execution.conditions)) for (const ref of Object.values(condition.expectations)) {
    const bytes = await readFile(ref.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256);
    const projection = JSON.parse(bytes).projection;
    observations.push(fingerprint({ subject_observer_files: projection.visibility.projection.files, pi_files: projection.pi.files,
      node: projection.node.sha256, bun: projection.bun.sha256, ...(projection.git ? { git: projection.git } : {}) }));
  }
  const collectorFiles = new Map();
  async function visit(url) {
    const path = fileURLToPath(url); if (collectorFiles.has(path)) return;
    const name = relative(dirname(root), path); assert.ok(name && !name.startsWith('..'));
    const bytes = await readFile(path);
    collectorFiles.set(path, { path: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    if (!path.endsWith('.mjs')) return;
    for (const match of bytes.toString('utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:(?:[^\n;]+?)\s+from\s+)?['\"](\.[^'\"]+)['\"]/g))
      await visit(new URL(match[1], url));
  }
  await visit(new URL('./collect.mjs', import.meta.url));
  const collector = [...collectorFiles.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, runtime_sha256: [...new Set(observations)].sort(), collector_files: collector,
    collector_sha256: fingerprint(collector), scope: 'exact observer projection, maintained SDK modules and collector static dependency closure' };
}
