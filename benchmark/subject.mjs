import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory } from '../scripts/paired-environment.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const within = (parent, child) => { const rel = relative(parent, child); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };

async function filesAt(root, prefix = '', includeMode = false) {
  const files = [];
  for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? prefix + '/' + item.name : item.name;
    assert.ok(!item.isSymbolicLink(), 'Visible input cannot contain links: ' + path);
    if (item.isDirectory()) files.push(...await filesAt(root, path, includeMode));
    else {
      assert.ok(item.isFile(), 'Visible input must be ordinary files');
      const bytes = await readFile(join(root, path));
      files.push({ path, sha256: sha(bytes), bytes: bytes.length, ...(includeMode ? { executable: Boolean((await lstat(join(root, path))).mode & 0o111) } : {}) });
    }
  }
  return files;
}
export const inventoryPublicInputs = root => filesAt(root, '', true);

/** Controller wrapper inside one shared-isolator command run. It never contains the grading oracle. */
export async function launchSubject(launch) {
  const runRoot = process.env.PAIRED_RUN_ROOT, buildRoot = process.env.PAIRED_BUILD_ROOT;
  assert.ok(isAbsolute(runRoot) && isAbsolute(buildRoot));
  assert.equal(await realpath(runRoot), runRoot);
  const sharedRun = JSON.parse(await readFile(join(runRoot, 'run.json'), 'utf8'));
  assert.equal(sharedRun.run_id, launch.run_id);
  assert.equal(sharedRun.build_root, buildRoot);
  assert.ok(isAbsolute(launch.source_retention_root) && !within(runRoot, launch.source_retention_root));
  assert.ok(isAbsolute(launch.input_root));
  const source = join(runRoot, 'source'), retained = join(launch.source_retention_root, launch.run_id);
  assert.ok((await lstat(source)).isDirectory());
  await mkdir(launch.source_retention_root, { recursive: true });
  const sourceFiles = await inventory(source);
  await rename(source, retained);
  await save(join(launch.source_retention_root, launch.run_id + '.json'), { version: 1, run_id: launch.run_id,
    from: source, to: retained, disposition: 'retained_outside_subject_run', inventory_sha256: sourceFiles.sha256,
    file_count: sourceFiles.files.length, at: new Date().toISOString(), isolation: 'declared-visibility-not-os-sandbox' });
  const projectionRoot = join(runRoot, 'subject-runtime');
  await mkdir(join(projectionRoot, 'benchmark/runtime'), { recursive: true });
  await mkdir(join(projectionRoot, 'scripts'));
  const origin = join(buildRoot, 'source/broker');
  const selected = (await readdir(join(origin, 'benchmark/runtime'))).filter(name => /^episode-.*\.mjs$/.test(name) && !name.endsWith('.test.mjs'));
  assert.ok(selected.includes('episode-runner.mjs'));
  for (const name of selected) await cp(join(origin, 'benchmark/runtime', name), join(projectionRoot, 'benchmark/runtime', name), { errorOnExist: true, force: false });
  // This module has only Node dependencies. Private fixture APIs and policies
  // remain in the parent controller and are not part of the subject projection.
  await cp(join(origin, 'benchmark/turn-bridge.mjs'), join(projectionRoot, 'benchmark/turn-bridge.mjs'), { errorOnExist: true, force: false });
  for (const name of ['skill-consumption-provider.mjs', 'skill-consumption-source-observer.mjs', 'notion-skill-graph-model-evidence.mjs',
    'notion-default-context.mjs', 'notion-integration-hosts.mjs'])
    await cp(join(origin, 'scripts', name), join(projectionRoot, 'scripts', name), { errorOnExist: true, force: false });
  const projection = await filesAt(projectionRoot);
  assert.ok(projection.every(file => !/(?:^|\/)(?:corpus|analysis|evidence|tests?)(?:\/|$)|(?:oracle|grader|\.test\.)/.test(file.path)));
  const visibility = join(runRoot, 'subject-visibility.json');
  await save(visibility, { version: 1, source_moved_outside_run: true, projection_root: 'subject-runtime', files: projection });
  const inputsBefore = await inventoryPublicInputs(launch.input_root);
  assert.equal(sha(JSON.stringify(inputsBefore)), launch.input_inventory_sha256, 'Frozen public task inputs changed');
  const workspace = join(runRoot, 'workspace');
  for (const item of await readdir(launch.input_root)) await cp(join(launch.input_root, item), join(workspace, item), { recursive: true, dereference: false, errorOnExist: true, force: false });
  assert.deepEqual(await inventoryPublicInputs(workspace), inputsBefore, 'Public task copy differs');
  await save(join(runRoot, 'subject-inputs.json'), { version: 1, files: inputsBefore, inventory_sha256: launch.input_inventory_sha256 });
  for (const key of ['PAIRED_CLI_SOURCE', 'PAIRED_BROKER_SOURCE', 'CONTEXT_BROKER_GRAPH_CORE', 'NTN_SKILLS_BUILD_ENTRY']) delete process.env[key];
  const config = { ...launch.runtime_config, runRoot, buildRoot, workspace, agentDir: join(runRoot, 'pi-agent'),
    controlDir: join(runRoot, 'benchmark/runtime'), visibility };
  const { runEpisode } = await import(pathToFileURL(join(projectionRoot, 'benchmark/runtime/episode-runner.mjs')).href);
  let bridge, result;
  try {
    if (launch.turn_bridge) {
      assert.deepEqual(Object.keys(launch.turn_bridge).sort(), ['episodeId', 'limits', 'runId', 'runRoot']);
      assert.equal(launch.turn_bridge.runRoot, runRoot); assert.equal(launch.turn_bridge.runId, launch.run_id);
      assert.equal(launch.turn_bridge.episodeId, launch.run_id);
      const { connectTurnBridge } = await import(pathToFileURL(join(projectionRoot, 'benchmark/turn-bridge.mjs')).href);
      bridge = await connectTurnBridge({ ...launch.turn_bridge, turns: config.turns });
    }
    result = await runEpisode(config, bridge ? { afterTurn: bridge.afterTurn } : {});
  } finally {
    if (bridge) await save(join(runRoot, 'benchmark/turn-bridge/subject-result.json'), await bridge.close());
  }
  await save(join(runRoot, 'benchmark/runtime-return.json'), result);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Supply one controller launch JSON file');
    assert.ok(isAbsolute(process.argv[2]));
    const result = await launchSubject(JSON.parse(await readFile(process.argv[2], 'utf8')));
    process.stdout.write(JSON.stringify({ status: result.status, run_id: process.env.PAIRED_RUN_ROOT, paths: result.paths }) + '\n');
    if (!['captured', 'completed', 'budget_stopped'].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.name, message: error.message }) + '\n'); process.exitCode = 1;
  }
}
