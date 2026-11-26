/** Read-only closeout of a paired environment's two source checkouts. No cleanup action. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const NAMES = ['cli', 'broker'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => path.startsWith(root + sep);
const same = (actual, expected, message) => assert.deepEqual(actual, expected, message);
function keys(value, required, optional = []) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  for (const key of required) assert.ok(Object.hasOwn(value, key), 'Missing field: ' + key);
  for (const key of Object.keys(value)) assert.ok([...required, ...optional].includes(key), 'Unknown field: ' + key);
}
function text(value, name) { assert.equal(typeof value, 'string', name); assert.ok(value.trim(), name + ' is empty'); return value; }
function sha(value) { assert.match(value, /^[a-f0-9]{64}$/); return value; }
function commit(value) { assert.match(value, /^[a-f0-9]{40}$/); return value; }
async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function canonical(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path, 'Use a canonical absolute path');
  assert.equal(await realpath(path), path, 'Symlink paths are not owned closeout inputs');
}
async function file(path) {
  await canonical(path); assert.ok((await lstat(path)).isFile(), 'Expected a regular file');
  const bytes = await readFile(path);
  return { reference: { path, sha256: digest(bytes), bytes: bytes.length }, value: JSON.parse(bytes) };
}
async function retainedFile(root, ref) {
  keys(ref, ['path', 'sha256'], ['bytes']); sha(ref.sha256);
  assert.ok(inside(join(root, 'control'), ref.path), 'Evidence must be owned by this environment control directory');
  const loaded = await file(ref.path); assert.equal(loaded.reference.sha256, ref.sha256, 'Retained evidence hash changed');
  if (ref.bytes !== undefined) assert.equal(loaded.reference.bytes, ref.bytes, 'Retained evidence size changed');
  return loaded.value;
}
function git(path, ...args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', path, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
    env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
  }).trimEnd();
}
function ancestor(path, head, target) {
  try { git(path, 'merge-base', '--is-ancestor', head, target); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}
function integration(path, expected, head, branches) {
  keys(expected, ['target_ref', 'target_commit', 'merged_commit', 'method']);
  assert.ok(typeof expected.target_ref === 'string' && expected.target_ref.startsWith('refs/remotes/'), 'Use an explicit remote-tracking ref');
  try { git(path, 'check-ref-format', expected.target_ref); }
  catch { assert.fail('Invalid integration target ref'); }
  const remotes = git(path, 'remote').split('\n').filter(name => name && expected.target_ref.startsWith('refs/remotes/' + name + '/'));
  assert.equal(remotes.length, 1, 'Integration target must name exactly one configured remote');
  text(git(path, 'remote', 'get-url', remotes[0]), 'Integration remote URL');
  commit(expected.target_commit); commit(expected.merged_commit);
  assert.equal(git(path, 'rev-parse', '--verify', expected.target_ref + '^{commit}'), expected.target_commit, 'Local target ref changed');
  assert.ok(ancestor(path, expected.merged_commit, expected.target_commit), 'Merge commit is outside the declared target');
  const mergedTree = git(path, 'rev-parse', expected.merged_commit + '^{tree}');
  if (expected.method === 'ancestor') assert.ok(ancestor(path, head, expected.merged_commit), 'Source HEAD is not integrated');
  else { assert.equal(expected.method, 'tree_equal', 'Unsupported integration proof'); assert.equal(git(path, 'rev-parse', head + '^{tree}'), mergedTree, 'Source and integrated commit trees differ'); }
  return { ...expected, verified: true, unmerged_local_branches: branches.filter(branch =>
    !ancestor(path, branch.head, expected.target_commit) && git(path, 'rev-parse', branch.head + '^{tree}') !== mergedTree) };
}
async function builds(root, environment) {
  const directory = join(root, 'builds'), found = [];
  if (!await exists(directory)) return found;
  await canonical(directory);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.ok(!entry.isSymbolicLink(), 'Build directory is a symlink');
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, 'build.json');
    if (!await exists(path)) continue; // Failed builds remain untouched; they have no runnable sealed build.
    const { reference, value } = await file(path);
    assert.equal(value.version, 1); assert.equal(value.kind, 'paired-build');
    assert.equal(value.environment_id, environment.environment_id); assert.equal(value.root, dirname(path));
    assert.equal(value.build_id, entry.name);
    found.push({ kind: 'frozen_build', path, sha256: reference.sha256 });
  }
  return found;
}
async function checkout(root, name, environment, references) {
  const path = join(root, name);
  assert.equal(environment.repositories[name].path, path, 'Source checkout is not the owned paired path');
  const state = await exists(path);
  if (!state) return { path, present: false, references };
  assert.ok(state.isDirectory() && !state.isSymbolicLink(), 'Source is not a real directory');
  await canonical(path); await canonical(join(path, '.git'));
  assert.ok((await lstat(join(path, '.git'))).isDirectory(), 'Independent Git metadata is required');
  assert.equal(git(path, 'rev-parse', '--show-toplevel'), path, 'Git root does not match the source');
  const worktrees = git(path, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  const porcelain = git(path, 'status', '--porcelain=v1', '--untracked-files=all');
  return { path, present: true, head: git(path, 'rev-parse', 'HEAD'), tree: git(path, 'rev-parse', 'HEAD^{tree}'),
    branch: git(path, 'branch', '--show-current') || null, clean: porcelain === '', porcelain,
    stashes: git(path, 'stash', 'list', '--format=%H').split('\n').filter(Boolean), worktrees,
    local_branches: git(path, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads').split('\n').filter(Boolean).map(line => {
      const [ref, head] = line.split(' '); return { ref, head };
    }), references };
}
function pointer(value, path) {
  assert.match(path, /^(?:\/(?:[^~]|~[01])*)+$/);
  for (const part of path.slice(1).split('/').map(value => value.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    assert.ok(value && typeof value === 'object' && Object.hasOwn(value, part), 'Missing reference pointer'); value = value[part];
  }
  return value;
}
async function references(root, source, declared, frozen) {
  assert.ok(Array.isArray(declared)); const paths = new Set(), result = [];
  for (const ref of declared) {
    assert.ok(!paths.has(ref.path), 'Repeated source reference'); paths.add(ref.path);
    if (ref.kind === 'frozen_build') {
      keys(ref, ['kind', 'path', 'sha256']);
      const actual = frozen.find(item => item.path === ref.path); assert.ok(actual, 'Not an owned retained frozen build'); same(ref, actual, 'Frozen build reference changed');
    } else {
      keys(ref, ['kind', 'path', 'sha256', 'pointer', 'target']);
      assert.equal(ref.kind, 'owned_json_reference', 'Unsupported source reference kind');
      assert.ok(['environment', 'source'].includes(ref.target));
      const data = await retainedFile(root, { path: ref.path, sha256: ref.sha256 });
      assert.equal(pointer(data, ref.pointer), ref.target === 'source' ? source.path : root, 'Record does not reference this paired source');
    }
    result.push(ref);
  }
  for (const ref of frozen) assert.ok(paths.has(ref.path), 'Missing retained frozen-build source dependency');
  return result;
}
async function trashed(root, name, environmentRef, environment, source, decision, expected) {
  keys(decision, ['kind', 'pre_audit', 'trash_receipt']);
  assert.equal(source.present, false, 'A present source checkout cannot be reported as trashed');
  assert.equal(source.references.length, 0, 'A retained build/live reference still requires this source');
  const before = await retainedFile(root, decision.pre_audit);
  assert.equal(before.version, 1); assert.equal(before.kind, 'paired-source-closeout-audit');
  assert.equal(before.root, root); assert.equal(before.environment_id, environment.environment_id);
  same(before.environment, environmentRef, 'Environment identity changed after pre-audit');
  const prior = before.sources[name]; assert.ok(prior?.present && prior.clean, 'A clean pre-trash source audit is required');
  assert.equal(prior.path, source.path); assert.equal(prior.head, expected.head);
  assert.equal(prior.references.length, 0, 'Pre-trash audit has retained source dependencies');
  assert.equal(prior.stashes.length, 0, 'Stashes must be retained before source cleanup');
  same(prior.worktrees, [source.path], 'Other worktrees still depend on the source Git metadata');
  same(prior.integration, { ...expected.integration, verified: true, unmerged_local_branches: [] }, 'Pre-trash integration proof is absent or changed');
  const receipt = await retainedFile(root, decision.trash_receipt);
  keys(receipt, ['version', 'kind', 'environment_id', 'source_path', 'source_head', 'pre_audit', 'command', 'exit_code', 'stdout', 'stderr', 'destination_path']);
  assert.equal(receipt.version, 1); assert.equal(receipt.kind, 'paired-source-system-trash');
  assert.equal(receipt.environment_id, environment.environment_id); assert.equal(receipt.source_path, source.path);
  assert.equal(receipt.source_head, expected.head); same(receipt.pre_audit, decision.pre_audit);
  same(receipt.command, { path: '/usr/bin/trash', args: ['-v', source.path] }); assert.equal(receipt.exit_code, 0);
  const destination = text(receipt.destination_path, 'Trash destination');
  assert.equal(resolve(destination), destination); assert.equal(dirname(destination), join(homedir(), '.Trash'));
  assert.ok(typeof receipt.stdout === 'string' && receipt.stdout.includes(destination), 'Native Trash acknowledgement is missing');
  assert.equal(typeof receipt.stderr, 'string');
  return { ...source, head: prior.head, integration: prior.integration, disposition: decision,
    trash_verification: { source_absent: true, native_acknowledgement: true, destination_path: destination, destination_bytes: 'not_verified' } };
}

/** Without a manifest, return a non-final identity snapshot. Receipt writing is explicit and exclusive. */
export async function closeoutEnvironment(options) {
  const root = options.root; await canonical(root);
  const loaded = await file(join(root, 'environment.json')), environment = loaded.value;
  assert.equal(environment.version, 1); assert.equal(environment.kind, 'paired-development-environment'); assert.equal(environment.root, root);
  same(Object.keys(environment.repositories).sort(), [...NAMES].sort(), 'Expected the paired source repositories');
  const frozen = await builds(root, environment), sources = {};
  for (const name of NAMES) sources[name] = await checkout(root, name, environment, frozen);
  const initialSources = structuredClone(sources); let manifestInput;
  const result = { version: 1, kind: 'paired-source-closeout-audit', created_at: new Date().toISOString(), root,
    environment_id: environment.environment_id, environment: loaded.reference,
    coverage: { source_paths: NAMES.map(name => join(root, name)), references: 'All own sealed builds plus explicitly declared owned JSON references',
      foreign_references: 'not_scanned', remote_ref_freshness: 'local_refs_only', deletion_performed: false }, sources, status: 'review_required' };
  if (options.manifest) {
    assert.ok(inside(join(root, 'control'), options.manifest), 'Manifest must be in the owned control directory');
    const manifest = await file(options.manifest), value = manifest.value; manifestInput = value;
    keys(value, ['version', 'kind', 'environment', 'sources']); assert.equal(value.version, 1); assert.equal(value.kind, 'paired-source-closeout');
    same(value.environment, loaded.reference, 'Manifest environment identity changed'); keys(value.sources, NAMES);
    result.manifest = manifest.reference;
    let pending = false, retained = 0;
    for (const name of NAMES) {
      const expected = value.sources[name], source = sources[name];
      keys(expected, ['head', 'integration', 'references'], ['disposition']); commit(expected.head);
      source.references = await references(root, source, expected.references, frozen);
      const decision = expected.disposition;
      if (decision?.kind === 'trashed') { sources[name] = await trashed(root, name, loaded.reference, environment, source, decision, expected); continue; }
      assert.ok(source.present, 'Missing source needs a complete bound Trash receipt');
      assert.equal(source.head, expected.head, 'Current source HEAD changed'); assert.ok(source.clean, 'Source checkout is dirty');
      source.integration = integration(source.path, expected.integration, source.head, source.local_branches);
      if (decision == null) { pending = true; continue; }
      keys(decision, ['kind', 'owner', 'release_condition']); assert.equal(decision.kind, 'retained', 'Choose retained or trashed');
      text(decision.owner, 'Retention owner'); keys(decision.release_condition, ['kind', 'description']);
      assert.ok(['references_retired', 'environment_retired'].includes(decision.release_condition.kind)); text(decision.release_condition.description, 'Release condition');
      assert.ok(source.references.length, 'Retention requires a current typed source dependency');
      if (frozen.length) assert.equal(decision.release_condition.kind, 'environment_retired', 'Frozen live-HEAD dependencies require explicit environment retirement');
      source.disposition = decision; retained++;
    }
    result.status = pending ? 'review_required' : retained ? 'reviewed_with_retained_sources' : 'sources_trashed';
  }
  same((await file(join(root, 'environment.json'))).reference, loaded.reference, 'Environment changed during closeout');
  same(await builds(root, environment), frozen, 'Retained builds changed during closeout');
  for (const name of NAMES) same(await checkout(root, name, environment, frozen), initialSources[name], 'Source changed during closeout');
  if (manifestInput) {
    same((await file(options.manifest)).reference, result.manifest, 'Manifest changed during closeout');
    for (const name of NAMES) {
      const expected = manifestInput.sources[name];
      await references(root, sources[name], expected.references, frozen);
      if (expected.disposition?.kind === 'trashed') {
        await retainedFile(root, expected.disposition.pre_audit); await retainedFile(root, expected.disposition.trash_receipt);
      } else assert.equal(git(sources[name].path, 'rev-parse', '--verify', expected.integration.target_ref + '^{commit}'), expected.integration.target_commit, 'Local target ref changed during closeout');
    }
  }
  if (options.receipt) {
    assert.ok(isAbsolute(options.receipt) && resolve(options.receipt) === options.receipt && inside(join(root, 'control'), options.receipt), 'Receipt must be an owned absolute control path');
    await canonical(dirname(options.receipt));
    await writeFile(options.receipt, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return result;
}
