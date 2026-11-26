import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export const exists = async path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}

export function normalizeCandidate(value, prefixes) {
  const replacements = Object.entries(prefixes).filter(([, path]) => typeof path === 'string' && path.length > 1).sort((a, b) => b[1].length - a[1].length);
  const visit = input => {
    if (typeof input === 'string') { for (const [label, path] of replacements) input = input.split(path).join('$' + label); return input; }
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, visit(child)]));
    return input;
  };
  return canonical(visit(value));
}

export function candidateDifferences(expected, actual, path = '') {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
  if (Array.isArray(expected) || Array.isArray(actual) || !expected || !actual || typeof expected !== 'object' || typeof actual !== 'object') return [{ path: path || '/', expected, actual }];
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort().flatMap(key => candidateDifferences(expected[key], actual[key], path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1')));
}

export async function fileIdentity(path, id) {
  const bytes = await readFile(path);
  return { ...(id ? { id } : {}), path, realpath: await realpath(path), sha256: sha256(bytes), bytes: bytes.length };
}

/** Re-observe the run-bound Git entry; its version comes from the shared subprocess probe. */
export async function observeSharedGit(runRoot) {
  const shared = await readJson(join(runRoot, 'run.json'));
  const selected = shared.runtime?.git;
  if (selected === undefined) return undefined;
  assert.equal(selected.status, 'observed', 'BENCHMARK_GIT_IDENTITY_UNKNOWN');
  assert.ok(typeof selected.version === 'string' && selected.version.startsWith('git version '), 'BENCHMARK_GIT_VERSION_UNKNOWN');
  const actual = await fileIdentity(join(runRoot, 'bin/git'));
  assert.equal(actual.realpath, selected.path, 'BENCHMARK_GIT_SELECTION_DRIFT');
  assert.equal(actual.sha256, selected.sha256, 'BENCHMARK_GIT_BYTES_DRIFT');
  return { ...actual, version: selected.version, version_source: 'shared-run subprocess --version; entry bytes re-observed before admission' };
}

export async function inventory(root) {
  const files = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), stat = await lstat(path);
      assert.ok(!stat.isSymbolicLink(), 'BENCHMARK_VISIBLE_SYMLINK: ' + path);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) { const item = await fileIdentity(path); files.push({ path: relative(root, path), sha256: item.sha256, bytes: item.bytes }); }
      else throw new Error('BENCHMARK_VISIBLE_NON_FILE: ' + path);
    }
  }
  await visit(root);
  return { files, sha256: sha256(JSON.stringify(files)) };
}

/** A locator binds the final bytes, not an event's self-reported checksum. */
export async function createEpisodeRecorder(directory, correlation, credentials = []) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const eventPath = join(directory, 'events.jsonl'), fd = openSync(eventPath, 'wx', 0o600), artifacts = [];
  let sequence = 0, closed = false, current = { turn_id: null, request_id: null };
  const overhead = { record_sync_wall_ms: 0, artifact_write_wall_ms: 0, event_bytes: 0, event_count: 0, artifact_count: 0 };
  const secrets = credentials.filter(value => typeof value === 'string' && value.length > 3);
  const scrub = value => JSON.parse(JSON.stringify(value, (key, item) => {
    if (typeof item === 'string' && /^(apiKey|api_key|authorization|access_token|refresh_token)$/i.test(key)) return '[REDACTED_CREDENTIAL]';
    if (typeof item === 'string') for (const secret of secrets) item = item.split(secret).join('[REDACTED_CREDENTIAL]');
    if (typeof item === 'bigint') return item.toString();
    return item;
  }));
  const record = (type, data = {}, bindings = {}) => {
    const started = performance.now();
    assert.ok(!closed, 'BENCHMARK_RECORDER_CLOSED');
    const event = { version: 1, sequence: ++sequence, wall_time: new Date().toISOString(), monotonic_ns: process.hrtime.bigint().toString(), ...correlation, ...current, ...bindings, type, data: scrub(data) };
    const text = JSON.stringify(event) + '\n'; writeSync(fd, text);
    overhead.record_sync_wall_ms += performance.now() - started; overhead.event_bytes += Buffer.byteLength(text); overhead.event_count++;
    return { artifact_id: 'events', line: sequence };
  };
  const save = async (id, value) => {
    const started = performance.now();
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    const path = join(directory, id + '.json');
    await writeFile(path, JSON.stringify(scrub(value), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const artifact = { ...await fileIdentity(path, id), kind: 'json' };
    artifacts.push(artifact);
    overhead.artifact_write_wall_ms += performance.now() - started; overhead.artifact_count++;
    return { artifact_id: id, sha256: artifact.sha256, pointer: '' };
  };
  return {
    directory, eventPath, artifacts, record, save, scrub, overhead,
    bind(bindings) { current = { ...current, ...bindings }; },
    async addArtifact(id, path, kind) { const artifact = { ...await fileIdentity(path, id), kind }; artifacts.push(artifact); return artifact; },
    async close() { if (!closed) { closed = true; closeSync(fd); artifacts.push({ ...await fileIdentity(eventPath, 'events'), kind: 'jsonl' }); } return artifacts; },
  };
}

export function bindReferences(value, artifacts) {
  const byId = new Map(artifacts.map(item => [item.id, item]));
  const visit = item => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') {
      if (item.artifact_id && !item.sha256) { const artifact = byId.get(item.artifact_id); assert.ok(artifact, 'BENCHMARK_MISSING_ARTIFACT'); return { ...item, sha256: artifact.sha256 }; }
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    }
    return item;
  };
  return visit(value);
}
