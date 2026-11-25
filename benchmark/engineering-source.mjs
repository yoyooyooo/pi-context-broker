import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINEERING_CONTROLLER_OVERLAY, ENGINEERING_SOURCE3_CONTROLLER_SHA256 } from './campaign-engineering-window-continuation.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const allowed = new Set(ENGINEERING_CONTROLLER_OVERLAY.map(path => 'benchmark/' + path));
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 32 * 1024 * 1024 });

/** Prospective preparation verifies real Git blobs. Historical authority reads
 * use the immutable composition hash and need no live Git checkout. */
export async function verifyReviewedEngineeringOverlay(composition) {
  assert.ok(isAbsolute(composition.reviewed_repository));
  assert.equal(await realpath(composition.reviewed_repository), composition.reviewed_repository);
  assert.match(composition.reviewed_commit, /^[a-f0-9]{40}$/);
  assert.equal(git(composition.reviewed_repository, ['rev-parse', '--verify', composition.reviewed_commit + '^{commit}']).toString().trim(), composition.reviewed_commit);
  for (const item of composition.overlay_files) {
    const repoPath = 'benchmark/' + item.path; assert.ok(allowed.has(repoPath), 'ENGINEERING_WINDOW_UNREVIEWED_SOURCE_CHANGE');
    const bytes = git(composition.reviewed_repository, ['show', composition.reviewed_commit + ':' + repoPath]);
    assert.equal(sha(bytes), item.sha256, 'ENGINEERING_WINDOW_REVIEWED_BLOB_CHANGED'); assert.equal(bytes.length, item.bytes);
    const actual = await readFile(resolve(composition.source_root, 'benchmark', item.path));
    assert.deepEqual(actual, bytes, 'ENGINEERING_WINDOW_OVERLAY_NOT_REVIEWED_COMMIT');
  }
}

async function sourceFiles(root) {
  const files = new Map();
  async function visit(path) {
    for (const name of (await readdir(path)).sort()) {
      const entry = join(path, name), info = await lstat(entry);
      assert.equal(info.isSymbolicLink(), false, 'ENGINEERING_WINDOW_SOURCE_SYMLINK');
      if (info.isDirectory()) await visit(entry);
      else { assert.ok(info.isFile()); files.set(relative(root, entry), await readFile(entry)); }
    }
  }
  await visit(root); return files;
}

/** Verify an already prepared NEW private source tree; this builder never
 * copies, patches or changes either source tree and performs no model work. */
export async function prepareEngineeringControllerComposition({ baseController, sourceRoot, reviewedRepository, reviewedCommit }) {
  assert.equal(baseController.sha256, ENGINEERING_SOURCE3_CONTROLLER_SHA256, 'ENGINEERING_WINDOW_RETAINED_SOURCE3_REQUIRED');
  const bytes = await readFile(baseController.path); assert.equal(sha(bytes), baseController.sha256);
  const base = JSON.parse(bytes);
  assert.ok(isAbsolute(sourceRoot)); assert.equal(await realpath(sourceRoot), sourceRoot); assert.notEqual(sourceRoot, base.source_root);
  const oldFiles = await sourceFiles(base.source_root), newFiles = await sourceFiles(sourceRoot), overlay = [];
  for (const [path, before] of oldFiles) assert.ok(newFiles.has(path), 'ENGINEERING_WINDOW_SOURCE_FILE_REMOVED:' + path);
  for (const [path, after] of newFiles) if (!oldFiles.has(path) || !oldFiles.get(path).equals(after)) {
    assert.ok(allowed.has(path), 'ENGINEERING_WINDOW_UNREVIEWED_SOURCE_CHANGE:' + path);
    overlay.push({ path: path.slice('benchmark/'.length), sha256: sha(after), bytes: after.length });
  }
  overlay.sort((a, b) => a.path.localeCompare(b.path));
  const composition = { version: 1, kind: 'benchmark-engineering-controller-composition', base_controller: structuredClone(baseController),
    source_root: sourceRoot, reviewed_repository: reviewedRepository, reviewed_commit: reviewedCommit, implementation: null, overlay_files: overlay };
  // Every changed source byte is proved before importing even implementation.mjs.
  await verifyReviewedEngineeringOverlay(composition);
  const { executionImplementation } = await import(pathToFileURL(join(sourceRoot, 'benchmark/implementation.mjs')));
  composition.implementation = await executionImplementation();
  return composition;
}
