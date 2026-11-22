import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { canonicalJson, fingerprint } from '../protocol.mjs';
import { renderJourney, validateRef } from './normalize.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };
function pointerValue(value, pointer) {
  for (const raw of pointer === '' ? [] : pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('Evidence JSON pointer does not exist: ' + pointer);
    value = value[key];
  }
  return value;
}
export async function verifyArtifactFiles(artifacts, { root, pathsBySha256 = {} } = {}) {
  const owned = root ? await realpath(root) : null;
  const output = new Map();
  for (const artifact of artifacts) {
    if (output.has(artifact.id)) throw new Error('Duplicate raw artifact ID');
    const selected = pathsBySha256[artifact.sha256] ?? artifact.path;
    const path = await realpath(isAbsolute(selected) ? selected : resolve(owned ?? '.', selected));
    if (owned && !inside(owned, path)) throw new Error('Raw artifact is outside the supplied evidence root');
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Raw artifact must be a file');
    const bytes = await readFile(path);
    if (hash(bytes) !== artifact.sha256 || artifact.bytes !== undefined && artifact.bytes !== bytes.length)
      throw new Error('Raw artifact hash or size mismatch: ' + artifact.id);
    output.set(artifact.id, { artifact, bytes, path });
  }
  return output;
}
export async function resolveEvidenceRef(ref, artifacts, options = {}) {
  const registry = new Map(artifacts.map(a => [a.id, a]));
  validateRef(ref, registry);
  const files = await verifyArtifactFiles([registry.get(ref.artifact_id)], options);
  const text = files.get(ref.artifact_id).bytes.toString('utf8');
  if (Object.hasOwn(ref, 'line')) {
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (ref.line > lines.length) throw new Error('Evidence line does not exist');
    return lines[ref.line - 1];
  }
  return pointerValue(JSON.parse(text), ref.pointer);
}
function allRefs(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (typeof value.artifact_id === 'string' && typeof value.sha256 === 'string' && ('line' in value || 'pointer' in value)) output.push(value);
  else for (const child of Object.values(value)) allRefs(child, output);
  return output;
}
export async function verifyBundle(bundle, options = {}) {
  const episode = bundle.episode;
  if (episode?.kind !== 'benchmark-normalized-episode' || episode.episode_sha256 !== fingerprint({ ...episode, episode_sha256: null }))
    throw new Error('Normalized episode fingerprint mismatch');
  const files = await verifyArtifactFiles(episode.artifacts, options);
  const registry = new Map(episode.artifacts.map(a => [a.id, a]));
  const checked = new Set();
  for (const ref of allRefs(bundle)) {
    validateRef(ref, registry);
    const key = canonicalJson(ref);
    if (checked.has(key)) continue;
    checked.add(key);
    const bytes = files.get(ref.artifact_id).bytes;
    if (Object.hasOwn(ref, 'line')) {
      const lines = bytes.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      if (ref.line > lines.length) throw new Error('Raw line locator exceeds artifact: ' + ref.artifact_id);
    } else pointerValue(JSON.parse(bytes.toString('utf8')), ref.pointer);
  }
  return { valid: true, raw_artifacts: files.size, references: checked.size, episode_sha256: episode.episode_sha256 };
}
async function writeOnce(path, bytes) {
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await readFile(path)).equals(Buffer.from(bytes))) throw new Error('Refusing to replace immutable evidence: ' + path);
  }
}
export async function writeEvidenceBundle({ directory, bundle, rawRoot }) {
  await verifyBundle(bundle, { root: rawRoot });
  await mkdir(directory, { recursive: true });
  const outputs = {
    'episode.json': canonicalJson(bundle.episode) + '\n',
    'events.jsonl': bundle.events.map(event => canonicalJson(event)).join('\n') + '\n',
    'journey.json': canonicalJson(bundle.journey) + '\n',
    'journey.md': renderJourney(bundle.journey),
  };
  const receipt = { schema_version: 1, kind: 'benchmark-evidence-bundle', episode_id: bundle.episode.identity.episode_id,
    raw_artifacts: bundle.episode.artifacts, files: Object.entries(outputs).map(([path, text])=>({ path, sha256: hash(text), bytes: Buffer.byteLength(text) })) };
  for (const [path, text] of Object.entries(outputs)) await writeOnce(join(directory, path), text);
  await writeOnce(join(directory, 'bundle.json'), canonicalJson(receipt) + '\n');
  return { directory, receipt, receipt_sha256: fingerprint(receipt) };
}
export async function readEvidenceBundle({ directory, rawRoot, verify = true }) {
  const receipt = JSON.parse(await readFile(join(directory, 'bundle.json'), 'utf8'));
  if (receipt.kind !== 'benchmark-evidence-bundle') throw new Error('Unknown evidence bundle');
  const files = {};
  for (const item of receipt.files) {
    if (!['episode.json', 'events.jsonl', 'journey.json', 'journey.md'].includes(item.path)) throw new Error('Unexpected bundle member');
    const bytes = await readFile(join(directory, item.path));
    if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error('Derived evidence file changed: ' + item.path);
    files[item.path] = bytes.toString('utf8');
  }
  const bundle = { episode: JSON.parse(files['episode.json']), events: files['events.jsonl'].trimEnd().split('\n').map(JSON.parse),
    journey: JSON.parse(files['journey.json']) };
  if (verify) await verifyBundle(bundle, { root: rawRoot });
  return bundle;
}
export function buildEvidenceIndex(episodes) {
  const runs = new Map();
  for (const episode of episodes) {
    const key = episode.identity.episode_id;
    const prior = runs.get(key);
    if (prior && prior.episode_sha256 !== episode.episode_sha256) throw new Error('Choose one explicit analysis view per episode; reanalysis is not another sample');
    if (!prior) runs.set(key, episode);
  }
  const rows = [...runs.values()].sort((a,b)=>a.identity.episode_id.localeCompare(b.identity.episode_id)).map(e=>({
    ...e.identity, episode_sha256: e.episode_sha256, normalizer_version: e.normalizer_version,
    validity: e.admission.status, outcome: e.result.outcome, verified_success: e.result.verified_success,
    unassisted_success: e.result.unassisted_success, evidence_completeness: e.admission.completeness,
    actual_attempts: e.measurements.actual_attempts, known_actual_attempts: e.measurements.known_actual_attempts,
    input_total: e.measurements.input_total, observed_rescues: e.measurements.observed_rescues,
    raw_artifacts: e.artifacts.map(a=>({id:a.id,path:a.path,sha256:a.sha256})),
  }));
  return { schema_version: 1, kind: 'benchmark-evidence-index', rows, index_sha256: fingerprint(rows) };
}
export function queryEvidenceIndex(index, filter = {}) {
  return index.rows.filter(row=>Object.entries(filter).every(([key,value])=>Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
}
export async function inventoryLegacyEvidence({ artifacts = [], label = 'historical evidence' } = {}) {
  const rows = [];
  for (const artifact of artifacts) {
    try {
      const bytes = await readFile(artifact.path), text = bytes.toString('utf8');
      let value = null, complete = true, parse_error = null;
      try {
        if (artifact.kind === 'jsonl') {
          complete = text.endsWith('\n');
          value = text.trimEnd() ? text.trimEnd().split('\n').map(line=>JSON.parse(line)) : [];
        } else if (artifact.kind === 'json') value = JSON.parse(text);
      } catch (error) { complete = false; parse_error = error.message; }
      const fields = {};
      for (const pointer of artifact.required_pointers ?? []) {
        try { pointerValue(value, pointer); fields[pointer] = 'observed'; } catch { fields[pointer] = 'unavailable'; }
      }
      rows.push({ id: artifact.id, path: artifact.path, status: complete ? 'available' : 'incomplete', bytes: bytes.length,
        sha256: hash(bytes), fields, parse_error, model_test_result: false });
    } catch (error) {
      if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error;
      rows.push({ id: artifact.id, path: artifact.path, status: 'unavailable', sha256: null, fields: {}, model_test_result: false });
    }
  }
  return { schema_version: 1, kind: 'benchmark-legacy-inventory', label, status: rows.length ? 'inventoried' : 'unavailable',
    entries: rows, imported_model_samples: 0,
    limitation: 'A historical functional report does not establish new comparative results. Missing or truncated raw observations remain unavailable.' };
}
