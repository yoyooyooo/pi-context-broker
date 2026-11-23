import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { canonicalJson, fingerprint } from '../protocol.mjs';
import { renderJourney, validateRef } from './normalize.mjs';
import { assessReportedModel, providerReportedModel, validateRoutingPolicy } from '../reported-model.mjs';
import { deriveRedactedProviderBinding } from '../provider-binding.mjs';

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

/** A real artifact hash is insufficient if a derived label points at another
 * request or invents a value. Verify the source field and the complete event set. */
function verifyReportedModelSources(episode, files, projection) {
  const routing = episode.identity?.model_routing;
  if (!routing) return;
  validateRoutingPolicy(routing);
  const identity = episode.identity;
  for (const key of ['model_route', 'model_provider', 'model_api'])
    if (typeof identity[key] !== 'string' || !identity[key]) throw new Error('Reported model identity requires ' + key);
  const registry = new Map([...files.values()].map(source => [source.artifact.id, source.artifact]));
  const clean = ref => {
    const mapped = projection?.get(ref.artifact_id);
    const sha256 = mapped && ref.sha256 === mapped.source_sha256 ? mapped.public_sha256 : ref.sha256;
    return Object.hasOwn(ref, 'line') ? { artifact_id: ref.artifact_id, sha256, line: ref.line }
      : { artifact_id: ref.artifact_id, sha256, pointer: ref.pointer ?? '' };
  };
  const rawValue = ref => {
    const locator = clean(ref); validateRef(locator, registry);
    const text = files.get(locator.artifact_id).bytes.toString('utf8');
    return locator.line !== undefined ? JSON.parse(text.split('\n')[locator.line - 1]) : pointerValue(JSON.parse(text), locator.pointer);
  };
  const bindingCache = new Map();
  function verifiedRedactedBinding(attempt, row) {
    const key = canonicalJson([attempt.request_id, attempt.id]);
    if (bindingCache.has(key)) return bindingCache.get(key);
    let verified = null;
    try {
      const binding = attempt.provider_binding;
      if (binding?.status !== 'known' || binding.value !== identity.model_provider || binding.observed_provider !== '[REDACTED_CREDENTIAL]' ||
        binding.formula !== 'unique-observed-provider-configuration-key/v1' || !binding.refs?.length) return null;
      const locators = new Set(binding.refs.map(ref => canonicalJson(clean(ref))));
      const boundRef = ref => {
        if (!locators.has(canonicalJson(clean(ref)))) throw new Error('Provider binding source is not retained in its proof');
        return rawValue(ref);
      };
      const boundFile = id => {
        if (!binding.refs.some(ref => ref.artifact_id === id)) throw new Error('Provider binding source is absent');
        return JSON.parse(files.get(id).bytes.toString('utf8'));
      };
      const runtime = JSON.parse(files.get('collection-runtime-result').bytes.toString('utf8'));
      const requests = runtime.requests.filter(request => request.id === attempt.request_id);
      if (requests.length !== 1) return null;
      const request = requests[0], attempts = request.attempts.filter(item => item.id === attempt.id);
      if (attempts.length !== 1 || attempts[0].transport_id !== attempt.transport_id) return null;
      const rawAttempt = attempts[0], candidate = boundFile('candidate-observed'), admission = boundFile('admission-comparison');
      const expected = boundFile('collection-provider-binding-expectation');
      const expectedArtifact = files.get('collection-provider-binding-expectation').artifact;
      if (admission.expected_file?.sha256 !== expectedArtifact.sha256 &&
        admission.expected_file?.sha256 !== projection?.get(expectedArtifact.id)?.source_sha256) return null;
      const protocol = JSON.parse(files.get('collection-protocol').bytes.toString('utf8'));
      const models = protocol.models.filter(model => model.id === identity.model_id);
      if (models.length !== 1) return null;
      const model = models[0];
      if (model.provider !== identity.model_provider || model.api !== identity.model_api || model.route !== identity.model_route ||
        canonicalJson(model.routing) !== canonicalJson(routing)) return null;
      const rows = binding.refs.map(rawValue);
      const transport = phase => {
        const matching = rows.filter(value => value?.phase === phase && value.id === rawAttempt.transport_id);
        if (matching.length !== 1) throw new Error('Provider binding needs one exact transport phase');
        return matching[0];
      };
      verified = deriveRedactedProviderBinding({ event: row, request, attemptId: attempt.id, model, candidate, expected, admission,
        requestStart: boundRef(request.start_ref), payload: boundRef(request.payload_ref), attemptStart: boundRef(rawAttempt.start_ref),
        transportStart: transport('request_start'), transportSent: transport('request_sent'), transportEnd: transport('request_end'), refs: binding.refs,
        publicProjection: Boolean(projection) });
    } catch { verified = null; }
    bindingCache.set(key, verified);
    return verified;
  }
  const sourceIds = new Set(files.has('events') ? ['events'] : []);
  for (const attempt of episode.attempts) for (const observation of attempt.reported_model?.observations ?? []) sourceIds.add(observation.ref.artifact_id);
  const rawEvents = new Map(), sources = new Map();
  const capture = (row, ref) => {
    if (row?.type !== 'provider_stream_event' || !providerReportedModel(row.data?.api, row.data?.event)) return;
    const key = canonicalJson(ref); rawEvents.set(key, { row, ref });
    const attemptKey = canonicalJson([row.data.request_id, row.data.attempt_id]);
    if (!sources.has(attemptKey)) sources.set(attemptKey, new Set());
    sources.get(attemptKey).add(key);
  };
  for (const artifactId of sourceIds) {
    const source = files.get(artifactId);
    if (!source) throw new Error('Reported model raw source is absent');
    const text = source.bytes.toString('utf8'), base = { artifact_id: artifactId, sha256: source.artifact.sha256 };
    if (source.artifact.kind === 'jsonl' || source.artifact.path.endsWith('.jsonl')) {
      const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
      lines.forEach((line, index) => capture(JSON.parse(line), { ...base, line: index + 1 }));
    } else {
      const walk = (value, pointer = '') => {
        if (!value || typeof value !== 'object') return;
        if (value.type === 'provider_stream_event') { capture(value, { ...base, pointer }); return; }
        for (const [key, child] of Object.entries(value)) walk(child, pointer + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'));
      };
      walk(JSON.parse(text));
    }
  }
  for (const attempt of episode.attempts) {
    const report = attempt.reported_model;
    if (!report || !Array.isArray(report.observations)) throw new Error('Reported model attempt evidence is absent');
    const expectedRefs = sources.get(canonicalJson([attempt.request_id, attempt.id])) ?? new Set(), actualRefs = new Set();
    for (const observation of report.observations) {
      const key = canonicalJson(observation.ref), raw = rawEvents.get(key);
      if (!raw || raw.row.data.request_id !== attempt.request_id || raw.row.data.attempt_id !== attempt.id)
        throw new Error('Reported model ref does not identify its original request and attempt');
      if (actualRefs.has(key)) throw new Error('Reported model raw event is duplicated');
      actualRefs.add(key);
      const original = providerReportedModel(raw.row.data.api, raw.row.data.event);
      if (original.field !== observation.field || canonicalJson(original.value) !== canonicalJson(observation.value))
        throw new Error('Reported model value or field differs from original server event');
      const providerBound = raw.row.data.provider === identity.model_provider || raw.row.data.provider === '[REDACTED_CREDENTIAL]' &&
        Boolean(verifiedRedactedBinding(attempt, raw.row));
      const bound = raw.row.data.api === identity.model_api && raw.row.data.model === identity.model_route && providerBound;
      if (observation.bound !== bound) throw new Error('Reported model event binding differs from raw request metadata');
    }
    if (expectedRefs.size !== actualRefs.size || [...expectedRefs].some(key => !actualRefs.has(key)))
      throw new Error('Reported model evidence omits an original server model event');
    const derived = assessReportedModel({ routing, sent: attempt.sent, observations: report.observations,
      providerError: report.provider_error, refs: report.refs });
    if (['status', 'reason', 'assurance', 'label_kind', 'reported_ids'].some(key => canonicalJson(report[key]) !== canonicalJson(derived[key])))
      throw new Error('Reported model verdict differs from frozen policy and original observations');
    if (derived.reason && episode.admission.status !== 'invalid') throw new Error('Reported model failure requires core invalidity');
  }
  const attemptKeys = new Set(episode.attempts.map(attempt => canonicalJson([attempt.request_id, attempt.id])));
  if (episode.admission.status !== 'invalid' && [...sources.keys()].some(key => !attemptKeys.has(key)))
    throw new Error('Reported model source contains an omitted attempt');
}

/** Only a caller that verified the public package manifest can opt in. A field
 * inside an episode never changes the default private verification boundary. */
function verifyPublicProjection(episode, files, descriptor) {
  const declaration = episode.identity?.public_projection;
  if (!descriptor) {
    if (declaration) throw new Error('Public projection requires an explicit verified manifest mapping');
    return null;
  }
  if (!declaration || !Array.isArray(descriptor.raw_mapping) || !/^[a-f0-9]{64}$/.test(descriptor.raw_mapping_sha256 ?? '') ||
    fingerprint(descriptor.raw_mapping) !== descriptor.raw_mapping_sha256 || declaration.raw_mapping_sha256 !== descriptor.raw_mapping_sha256)
    throw new Error('Public projection mapping fingerprint is not bound to the episode');
  const mapping = new Map();
  for (const row of descriptor.raw_mapping) {
    if (!/^[a-f0-9]{64}$/.test(row.source_sha256 ?? '') || !/^[a-f0-9]{64}$/.test(row.public_sha256 ?? '') ||
      !Number.isSafeInteger(row.source_bytes) || row.source_bytes < 0 || !Number.isSafeInteger(row.public_bytes) || row.public_bytes < 0 ||
      !['json', 'jsonl', 'text', 'binary'].includes(row.format) || mapping.has(row.source_sha256) ||
      row.line_locators !== (row.format === 'jsonl' ? 'preserved one-to-one' : 'not a JSONL artifact') ||
      row.inner_hash_claims !== 'historical original claims; transformed bytes are identified by public_sha256')
      throw new Error('Public projection mapping row is incomplete or ambiguous');
    mapping.set(row.source_sha256, row);
  }
  const projected = new Map();
  for (const { artifact, bytes } of files.values()) {
    const row = mapping.get(artifact.publication?.source_sha256);
    if (!row || row.public_sha256 !== artifact.sha256 || row.public_bytes !== bytes.length ||
      artifact.bytes !== row.public_bytes || artifact.publication.source_bytes !== row.source_bytes ||
      artifact.path !== row.public_path || artifact.publication.transformed !== row.changed ||
      typeof row.changed !== 'boolean' || (!row.changed && (row.source_sha256 !== row.public_sha256 || row.source_bytes !== row.public_bytes)) ||
      (artifact.kind === 'jsonl' || /jsonl$/.test(artifact.kind ?? '')) && row.format !== 'jsonl')
      throw new Error('Public projection artifact differs from its verified original-to-public mapping');
    if (row.format === 'json') JSON.parse(bytes.toString('utf8'));
    if (row.format === 'jsonl') {
      const lines = bytes.toString('utf8').split('\n'); if (lines.at(-1) === '') lines.pop();
      for (const line of lines) if (line !== '') JSON.parse(line);
    }
    projected.set(artifact.id, row);
  }
  return projected;
}
export async function verifyBundle(bundle, options = {}) {
  const episode = bundle.episode;
  if (episode?.kind !== 'benchmark-normalized-episode' || episode.episode_sha256 !== fingerprint({ ...episode, episode_sha256: null }))
    throw new Error('Normalized episode fingerprint mismatch');
  const files = await verifyArtifactFiles(episode.artifacts, options);
  const projection = verifyPublicProjection(episode, files, options.publicProjection);
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
  verifyReportedModelSources(episode, files, projection);
  return { valid: true, raw_artifacts: files.size, references: checked.size, episode_sha256: episode.episode_sha256,
    ...(projection ? { verification_scope: 'public-projection-file-hashes-and-source-fields; original-inner-hash-claims-not-recomputed' } : {}) };
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
