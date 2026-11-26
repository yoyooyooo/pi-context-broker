/** Retained Benchmark evidence contract: Notion SDK v2, resource-read v1,
 * Skill references v1 and preparation evidence v2. The original validation is
 * frozen from ecf9eeaa3adf324541c561627cb38b193a2d448f, from
 * scripts/notion-skill-graph-model-evidence.mjs and
 * scripts/skill-preparation-evidence.mjs. Only the functions used by collection
 * are retained. Current product validation remains in the shared scripts.
 *
 * This is a fixed historical interpreter, never a fallback after current
 * parsing fails. A receipt's observer version does not prove its SDK version;
 * retained-run applicability requires independently checked build provenance.
 * Library-qualified protocol-v2 identities are outside this contract.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const RETAINED_SOURCE_CONTRACT = 'notion-sdk-v2/resource-read-v1/skill-ref-v1/preparation-evidence-v2';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';


function rejectLibraryOwner(owner) {
  assert.ok(typeof owner !== 'string' || !/^skill:\/\//iu.test(owner),
    'Retained SDK-v2 evidence cannot use a Library-qualified owner');
}
function rejectLibraryRef(value) {
  // Preparation evidence also describes local paths and other source refs.
  // Their original validation remains below; this guard only excludes Library.
  if (typeof value !== 'string' || !/^skill:\/\//iu.test(value) || !URL.canParse(value)) return;
  assert.equal(new URL(value).searchParams.has('library'), false,
    'Retained Skill-ref-v1 evidence cannot use a Library-qualified reference');
}
function retainedOwner(owner) {
  assert.ok(typeof owner === 'string' && owner); rejectLibraryOwner(owner);
}
function retainedRef(value) {
  const ref = new URL(value);
  assert.equal(ref.protocol, 'skill:');
  rejectLibraryRef(value);
  return ref;
}
function retainedRecord(record) {
  retainedOwner(record.id);
  if (record.ref !== undefined) retainedRef(record.ref);
}

/** Read projections without turning one SDK result into extra source operations.
 * Legacy flat receipts keep their original shape; paired failures stay explicit. */
export function catalogFacets(value) {
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  assert.ok(object(value), 'A catalog result must be an object');
  if (!Object.hasOwn(value, 'catalog') && !Object.hasOwn(value, 'directory')) return [{ facet: 'flat', ok: true, value }];
  assert.equal(value.version, 1, 'Unknown combined catalog contract');
  const facets = ['catalog', 'directory'].map(facet => {
    const outcome = value[facet];
    assert.ok(object(outcome) && typeof outcome.ok === 'boolean', 'Both combined catalog outcomes are required');
    if (!outcome.ok) {
      assert.equal(Object.hasOwn(outcome, 'value'), false, 'A failed projection cannot supply a catalog');
      assert.ok(object(outcome.error) && typeof outcome.error.code === 'string' && outcome.error.code.length > 0);
      assert.equal(typeof outcome.error.message, 'string');
      return { facet, ok: false, error: outcome.error };
    }
    assert.equal(Object.hasOwn(outcome, 'error'), false, 'A successful projection cannot hide an error');
    assert.ok(object(outcome.value) && typeof outcome.value.scope === 'string' && outcome.value.scope.length > 0);
    assert.ok(Array.isArray(outcome.value.records) && Array.isArray(outcome.value.databases));
    if (facet === 'catalog') {
      assert.notEqual(outcome.value.coverage?.method, 'explicit_view');
      assert.ok(['view', 'view_selection', 'view_query', 'profile', 'capability_directory', 'query', 'limit', 'cursor', 'has_more', 'next_cursor', 'total_count']
        .every(key => !Object.hasOwn(outcome.value, key)), 'A selected or paged projection cannot claim the full catalog facet');
    }
    return { facet, ok: true, value: outcome.value };
  });
  if (facets.every(facet => facet.ok)) {
    const [full, directory] = facets.map(facet => facet.value);
    assert.equal(full.scope, directory.scope, 'Combined projections must share one credential scope');
    for (const database of full.databases) {
      const selected = directory.databases.find(item => item.database_id === database.database_id);
      if (selected) assert.deepEqual(database.shared_library, selected.shared_library,
        'Combined projections cannot mix shared-library descriptors for the same database');
    }
  }
  return facets;
}

/** Views of captured source facts, never fabricated CLI calls or extra HTTP receipts.
 * A consume entry carries its own immutable manifest and original body range.
 * The caller still checks actual provider delivery and the private source oracle. */
export function graphSourceViews(receipts) {
  const directories = [], directoryFailures = [], preparations = [], entries = [], resources = [];
  for (const receipt of receipts) {
    const sdk = receipt.transport === 'sdk';
    const value = sdk ? receipt.value : receipt.response;
    if (!value || (sdk ? receipt.status !== 'completed' || receipt.resultObserved !== true : receipt.code !== undefined && receipt.code !== 0)) continue;
    const operation = sdk ? receipt.operation : receipt.command;
    const observed = { requestId: receipt.requestId, transport: sdk ? 'sdk' : 'command', operation };
    if (operation === 'list') for (const outcome of catalogFacets(value)) {
      const projection = { ...observed, ...(outcome.facet === 'flat' ? {} : { facet: outcome.facet }) };
      if (!outcome.ok) directoryFailures.push({ ...projection, error: outcome.error });
      else if (Array.isArray(outcome.value.records)) {
        for (const record of outcome.value.records) retainedRecord(record);
        directories.push({ ...projection, value: outcome.value });
      }
    }
    if (operation === 'read' && value.record && typeof value.scope === 'string') {
      retainedRecord(value.record); if (value.ref !== undefined) retainedRef(value.ref);
      entries.push({ ...observed, value, ...(receipt.outputEvidence ? { outputEvidence: receipt.outputEvidence } : {}) });
    }
    if (operation === 'prepare' && value.status === 'ready') {
      for (const node of value.nodes ?? []) { retainedRecord(node.record); if (node.binding?.ref !== undefined) retainedRef(node.binding.ref); }
      preparations.push({ ...observed, value });
    }
    if (sdk && operation === 'read-resources' && value.status === 'ready') {
      const manifest = value.manifest, selection = value.selection;
      assert.equal(value.version, 1); assert.equal(manifest?.complete, true);
      retainedOwner(selection?.owner); retainedRecord(manifest.record);
      assert.equal(hash(canonical(manifest)), value.manifest_sha256, 'Observed resource manifest hash');
      assert.deepEqual(selection, { scope: manifest.scope, owner: manifest.record.id, snapshot_id: manifest.snapshot_id, version_id: manifest.version_id });
      assert.ok(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 16);
      const paths = new Set(), identities = new Set();
      for (const file of value.files) {
        const declared = manifest.files.filter(item => item.path === file.path), binding = manifest.file_bindings?.find(item => item.path === file.path);
        assert.equal(declared.length, 1); assert.notEqual(file.path, manifest.entrypoint);
        assert.equal(file.file_id, binding?.file_id); assert.ok(['utf8', 'base64'].includes(file.encoding));
        assert.equal(typeof file.content, 'string'); assert.equal(typeof file.requested_ref, 'string');
        const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
        assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256);
        assert.equal(declared[0].bytes, file.bytes); assert.equal(declared[0].sha256, file.sha256);
        const ref = retainedRef(file.ref), requested = retainedRef(file.requested_ref);
        for (const parsed of [ref, requested]) {
          assert.equal(parsed.protocol, 'skill:'); assert.equal(decodeURIComponent(parsed.hostname), selection.owner);
          assert.equal(parsed.searchParams.get('snapshot'), selection.snapshot_id);
        }
        assert.equal(ref.searchParams.get('file_id') ?? undefined, file.file_id);
        if (requested.searchParams.has('file_id')) assert.equal(requested.searchParams.get('file_id'), file.file_id);
        else assert.equal(requested.pathname, ref.pathname);
        assert.equal(ref.pathname.slice(1).split('/').map(decodeURIComponent).join('/'), file.path);
        const identity = file.file_id ?? file.path;
        assert.ok(!paths.has(file.path) && !identities.has(identity), 'A resource operation cannot duplicate a selected file');
        paths.add(file.path); identities.add(identity);
      }
      resources.push({ ...observed, value });
    }
    if (operation !== 'consume' || value.status !== 'ready') continue;
    assert.equal(value.version, 1, 'Observed SDK consumption contract version');
    const ready = value.preparation;
    assert.equal(ready?.status, 'ready');
    assert.ok(Array.isArray(ready.nodes) && Array.isArray(value.entries));
    const nodes = ready.nodes.filter(node => node.state === 'prepared');
    assert.deepEqual(value.entries.map(entry => entry.id).sort(), nodes.map(node => node.id).sort(), 'Observed SDK entries match the entire prepared closure');
    preparations.push({ ...observed, value: ready });
    for (const entry of value.entries) {
      const node = nodes.find(node => node.id === entry.id), manifest = entry.manifest, body = entry.source_body;
      assert.equal(manifest?.complete, true); assert.equal(manifest.scope, ready.scope);
      retainedRecord(manifest.record); retainedRef(body?.ref);
      assert.equal(hash(canonical(manifest)), entry.manifest_sha256, 'Observed SDK manifest hash');
      assert.deepEqual(manifest.record, node.record);
      assert.equal(manifest.snapshot_id, node.binding.snapshot_id); assert.equal(manifest.version_id, node.binding.version_id);
      assert.equal(manifest.entrypoint, node.path); assert.equal(body?.kind, 'verified_snapshot_entry');
      assert.equal(body.ref, node.binding.ref); assert.equal(body.path, node.path);
      assert.equal(body.has_more, false); assert.equal(body.range?.start, 1); assert.equal(body.range?.end, body.range?.total_lines);
      assert.ok(Number.isSafeInteger(body.range?.end) && body.range.end > 0);
      assert.equal(body.range.total_lines, node.content.split('\n').length, 'Observed complete source range');
      assert.equal(body.sha256, node.body_sha256); assert.equal(body.bytes, node.bytes);
      assert.equal(hash(node.content), body.sha256); assert.equal(Buffer.byteLength(node.content), body.bytes);
      const main = manifest.files.find(file => file.path === manifest.entrypoint);
      assert.equal(main?.sha256, body.sha256); assert.equal(main?.bytes, body.bytes);
      assert.ok(['entry_ready', 'all_files_ready'].includes(entry.materialization?.status));
      assert.ok(entry.materialization.paths.includes(node.path));
      assert.equal(entry.projection?.status, 'identity'); assert.equal(entry.projection.compiler, 'source-identity/v1');
      assert.equal(entry.projection.source_body_sha256, body.sha256); assert.equal(entry.projection.projection_sha256, body.sha256);
      assert.equal(entry.projection.bytes, body.bytes);
      entries.push({ ...observed, evidence: 'consume.entries', manifest, value: {
        record: manifest.record, scope: manifest.scope, snapshot_id: manifest.snapshot_id, version_id: manifest.version_id,
        path: body.path, ref: body.ref, content: node.content, bytes: body.bytes, sha256: body.sha256,
        file_bindings: manifest.file_bindings, range: body.range, has_more: body.has_more,
      } });
    }
  }
  return { directories, directoryFailures, preparations, entries, resources };
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, expected, message) {
  assert.ok(object(value), message);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), message);
}
function measure(value, text, message) {
  keys(value, ['sha256', 'bytes'], message);
  assert.equal(value.sha256, hash(text), message);
  assert.equal(value.bytes, Buffer.byteLength(text), message);
}

function verifyPublicDirectory(projected, canonical) {
  keys(projected, ['files', 'required', 'candidates', 'references'], 'Keep every directory group');
  assert.ok(object(canonical));
  for (const group of ['files', 'required', 'candidates', 'references']) {
    assert.ok(Array.isArray(projected[group]) && Array.isArray(canonical[group]));
    assert.equal(projected[group].length, canonical[group].length, 'Keep every directory row');
  }
  for (const file of canonical.files) rejectLibraryRef(file.ref);
  for (const group of ['required', 'candidates', 'references']) for (const relation of canonical[group])
    rejectLibraryRef(relation.ref);
  const fileIndex = relation => {
    if (relation?.kind !== 'file' || relation.availability !== 'available') return -1;
    let fixed = false;
    try {
      const ref = new URL(relation.ref);
      fixed = ref.protocol === 'skill:' && ref.searchParams.getAll('snapshot').length === 1
        && /^s_[a-f0-9]{64}$/u.test(ref.searchParams.get('snapshot'));
    } catch {}
    if (!fixed) return -1;
    const matches = canonical.files.flatMap((file, index) => file.ref === relation.ref && file.path === relation.name ? [index] : []);
    return matches.length === 1 ? matches[0] : -1;
  };
  for (const [index, file] of projected.files.entries()) {
    keys(file, ['path', 'ref', 'bytes', ...(file.description === undefined ? [] : ['description'])], 'Public file object');
    assert.equal(file.path, canonical.files[index].path); assert.equal(file.bytes, canonical.files[index].bytes);
    assert.ok(typeof file.ref === 'string' && file.ref);
    if (file.description !== undefined) {
      const refs = canonical.references.filter(reference => fileIndex(reference) === index);
      assert.ok(refs.length && refs.every(reference => reference.description === file.description), 'File description comes from its exact fixed reference');
      assert.ok(projected.references.some(reference => Object.keys(reference).length === 1 && reference.ref === file.ref), 'A shared file description needs its reference edge');
    }
  }
  for (const group of ['required', 'candidates', 'references']) {
    for (const [index, card] of projected[group].entries()) {
      const original = canonical[group][index];
      if (group === 'references' && object(card) && Object.keys(card).length === 1) {
        keys(card, ['ref'], 'Compact fixed file relation');
        const file = fileIndex(original);
        assert.ok(file >= 0, 'An unfixed or foreign reference keeps its independent card');
        assert.equal(card.ref, projected.files[file].ref);
        assert.equal(projected.files[file].description, original.description);
        continue;
      }
      keys(card, ['ref', 'kind', 'name', 'description', 'availability'], 'Full relation metadata');
      assert.ok(typeof card.ref === 'string' && card.ref);
      for (const field of ['kind', 'name', 'description', 'availability']) assert.deepEqual(card[field], original[field]);
    }
  }
}

/** Independent public-receipt validation; actual writes still need source/HTTP evidence. */
export function verifyConsumptionEffects(value) {
  keys(value, ['version', 'remote_writes', 'author_content'], 'Current consumption effects');
  assert.equal(value.version, 1);
  assert.ok(['none', 'unknown'].includes(value.remote_writes));
  assert.ok(['unchanged', 'unknown'].includes(value.author_content));
  if (value.remote_writes === 'none') assert.equal(value.author_content, 'unchanged');
  return value;
}

/** Verify captured tool content independently of the production compiler.
 * Source authenticity still requires each caller's original source oracle.
 * A derived parent's hash is a link, not proof that the parent was observed. */
export function verifyPreparationEvidence(content, proof, toolCallId) {
  assert.ok(typeof content === 'string' && content.length > 0, 'Preparation content is missing');
  assert.ok(typeof toolCallId === 'string' && toolCallId.length > 0, 'Preparation tool call is missing');
  const model = JSON.parse(content);
  assert.equal(content, JSON.stringify(model), 'Preparation projection must use its deterministic JSON encoding');
  keys(model, ['ok', 'status', 'purpose', 'roots', 'records', ...(model.effects === undefined ? [] : ['effects'])], 'Only compact preparation fields and effects are model-visible');
  if (model.effects !== undefined) verifyConsumptionEffects(model.effects);
  assert.equal(model.ok, true); assert.equal(model.status, 'ready');
  assert.ok(['use', 'inspect'].includes(model.purpose));
  assert.ok(Array.isArray(model.roots) && model.roots.length > 0 && model.roots.length <= 64);
  assert.ok(Array.isArray(model.records) && model.records.length > 0);
  assert.equal(proof?.version, 2, 'Only the frozen v2 preparation evidence is accepted');
  assert.equal(proof.toolCallId, toolCallId); assert.equal(proof.purpose, model.purpose);
  assert.ok(Array.isArray(proof.records) && proof.records.length === model.records.length);
  assert.ok(Array.isArray(proof.graphs) && proof.graphs.length > 0, 'Canonical graph proofs must remain in details');
  const projection = proof.projection;
  keys(projection, ['version', 'compiler', 'sourceProjection', 'rendered', 'records', ...(projection?.derived === undefined ? [] : ['derived'])], 'Projection evidence is versioned');
  assert.equal(projection.version, 1);
  assert.equal(projection.compiler, 'context-broker/skill-prepare/v1', 'Unknown preparation compiler');
  assert.equal(projection.sourceProjection, 'source-identity/v1', 'Author bytes remain source identity projection');
  measure(projection.rendered, content, 'Complete projection hash and byte count');
  assert.ok(Array.isArray(projection.records) && projection.records.length === model.records.length);
  if (projection.derived !== undefined) {
    keys(projection.derived, ['reason', 'parentSha256', ...(projection.derived.directories === undefined ? [] : ['directories'])], 'Derived projection link');
    assert.ok(['deduplicate', 'supersede'].includes(projection.derived.reason));
    assert.match(projection.derived.parentSha256, /^[a-f0-9]{64}$/u);
    if (projection.derived.directories !== undefined) {
      assert.ok(Array.isArray(projection.derived.directories) && projection.derived.directories.length);
      const indices = new Set();
      for (const directory of projection.derived.directories) {
        keys(directory, ['index', 'sha256', 'bytes'], 'An omitted generated directory keeps an exact identity digest');
        assert.ok(Number.isSafeInteger(directory.index) && directory.index >= 0 && directory.index < model.records.length
          && !indices.has(directory.index));
        indices.add(directory.index); assert.match(directory.sha256, /^[a-f0-9]{64}$/u);
        assert.ok(Number.isSafeInteger(directory.bytes) && directory.bytes > 0);
        assert.equal(model.records[directory.index].directory, undefined);
      }
    }
  }
  const seen = new Set();
  let cursor = content.indexOf('"records":[');
  const records = model.records.map((record, index) => {
    keys(record, ['name', 'kind', 'ref', 'content', ...(record?.directory === undefined ? [] : ['directory'])], 'Machine proof fields must stay in details');
    for (const key of ['name', 'kind', 'ref', 'content']) assert.equal(typeof record[key], 'string');
    assert.ok(record.ref.length > 0 && !seen.has(record.ref), 'Prepared references must be unique'); seen.add(record.ref);
    const receipt = proof.records[index], mapping = projection.records[index];
    assert.equal(receipt?.version, 2); assert.ok(typeof receipt.identity === 'string' && receipt.identity.length > 0);
    assert.ok(object(receipt.binding) && object(receipt.binding.record), 'The full selected source binding remains available');
    rejectLibraryOwner(receipt.binding.record.id); rejectLibraryRef(receipt.binding.record.ref);
    rejectLibraryRef(receipt.binding.ref); rejectLibraryRef(record.ref);
    assert.equal(receipt.binding.snapshot_id, receipt.snapshotId);
    assert.equal(receipt.binding.body_sha256, receipt.bodySha256);
    assert.match(receipt.bodySha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0);
    keys(mapping, ['index', 'ref', 'source', 'rendered', 'delivery', 'state'], 'Each source has an explicit rendered span');
    assert.equal(mapping.index, index); assert.equal(mapping.ref, record.ref);
    keys(mapping.source, ['identity', 'sha256', 'bytes'], 'Source identity and exact original bytes');
    assert.deepEqual(mapping.source, { identity: receipt.identity, sha256: receipt.bodySha256, bytes: receipt.bytes });
    const serialized = JSON.stringify(record), offset = content.indexOf(serialized, cursor);
    assert.ok(offset >= cursor, 'The span belongs to its own serialized record');
    const property = serialized.indexOf('"content":' + JSON.stringify(record.content));
    assert.ok(property >= 0);
    const start = offset + property + '"content":"'.length;
    const encoded = JSON.stringify(record.content).slice(1, -1);
    assert.deepEqual(mapping.delivery, { start, end: start + encoded.length, encoding: 'json' });
    assert.equal(content.slice(start, start + encoded.length), encoded);
    measure(mapping.rendered, encoded, 'Rendered record hash is the encoded JSON span');
    const decodedContent = JSON.parse('"' + encoded + '"');
    assert.equal(decodedContent, record.content); cursor = offset + serialized.length;
    if (mapping.state === 'source') {
      assert.equal(receipt.loaded, true); assert.deepEqual(receipt.delivery, mapping.delivery);
      assert.equal(hash(decodedContent), mapping.source.sha256, 'Complete source body hash');
      assert.equal(Buffer.byteLength(decodedContent), mapping.source.bytes, 'Complete source body bytes');
    } else {
      assert.equal(mapping.state, 'replaced', 'Unknown record projection state');
      assert.equal(receipt.loaded, false, 'A replaced span does not prove another source delivery');
      assert.ok(projection.derived, 'Replaced spans require an observed-parent link');
      assert.notEqual(hash(decodedContent), mapping.source.sha256, 'A replacement cannot masquerade as the original source span');
    }
    const directory = receipt.directory;
    const omittedDirectory = projection.derived?.directories?.find(value => value.index === index);
    if (omittedDirectory) {
      assert.ok(directory !== undefined, 'Omission applies only to an original generated directory');
      assert.equal(record.directory, undefined);
    } else assert.equal(record.directory === undefined, directory === undefined, 'Every non-reused canonical directory remains represented');
    if (directory !== undefined && !omittedDirectory) verifyPublicDirectory(record.directory, directory);
    return { model: record, receipt, mapping, decodedContent, ...(omittedDirectory ? { omittedDirectory } : {}) };
  });
  assert.ok(model.roots.every(ref => typeof ref === 'string' && seen.has(ref)), 'Every root has a prepared model record');
  if (projection.derived) assert.ok(records.some(record => record.mapping.state === 'replaced' || record.omittedDirectory), 'A derived result must identify its changed objects');
  return { model, projection, records };
}
