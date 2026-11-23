import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const encode = value => Buffer.from(canonical(value) + '\n');
const sameRef = (a, b) => assert.ok(a && b && a.path === b.path && a.sha256 === b.sha256, 'Recovery reference differs from its owning completed result');
const member = path => assert.ok(typeof path === 'string' && path && !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Recovery public member escapes its release');
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const pointerValue = (value, pointer) => pointer.slice(1).split('/').reduce((parent, key) => parent[key.replaceAll('~1', '/').replaceAll('~0', '~')], value);
function replacePointer(value, pointer, replacement) {
  assert.ok(typeof pointer === 'string' && pointer.startsWith('/'));
  const parts = pointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
  let parent = value; for (const key of parts.slice(0, -1)) { assert.ok(parent && Object.hasOwn(parent, key)); parent = parent[key]; }
  assert.ok(parent && Object.hasOwn(parent, parts.at(-1))); parent[parts.at(-1)] = replacement;
}

// Called only AFTER the owning scope reader has verified the recovery contract.
// load() is the assembler's canonical, owner-bounded, hash-checked stable reader.
// It is read-only; no recovery/controller command is imported or invoked here.
export async function collectRecoveryAudit({ plan, planFile, effective, ledgerBytes, load }) {
  const reference = effective.collection_recovery ?? null;
  const tagged = effective.completed.filter(row => row.result.collection_recovery);
  if (!reference) { assert.equal(tagged.length, 0, 'Recovery-tagged completion lacks its scope registration'); return null; }
  assert.equal(tagged.length, effective.completed.length, 'Recovery scope contains an unbound completion');
  for (const row of tagged) sameRef(row.result.collection_recovery, reference);
  const documents = new Map();
  function document(bytes, format) {
    const sourceSha = sha(bytes), id = 'doc-' + sourceSha + '-' + format;
    if (!documents.has(id)) documents.set(id, { id, format, source_sha256: sourceSha, source_bytes: bytes.length, content: bytes });
    return id;
  }
  async function retained(ref) {
    const exact = { path: ref.path, sha256: ref.sha256, ...(ref.bytes === undefined ? {} : { bytes: ref.bytes }) };
    const bytes = await load(exact); assert.equal(sha(bytes), ref.sha256); if (ref.bytes !== undefined) assert.equal(bytes.length, ref.bytes); return bytes;
  }
  async function read(ref, format = 'json') {
    const bytes = await retained(ref);
    return { document: document(bytes, format), value: format === 'json' ? parse(bytes) : null };
  }
  const original = await read(reference), registration = original.value;
  assert.equal(registration.version, 1); assert.equal(registration.kind, 'benchmark-collection-recovery');
  assert.equal(registration.plan.sha256, planFile.sha256); assert.equal(registration.plan.plan_sha256, plan.plan_sha256);
  const prefix = ledgerBytes.subarray(0, registration.ledger_prefix.bytes);
  assert.equal(sha(prefix), registration.ledger_prefix.sha256); assert.equal(prefix.at(-1), 10);
  const prefixRows = prefix.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(prefixRows.length, registration.ledger_prefix.through_seq);
  const ledgerDocument = document(prefix, 'jsonl');
  const closures = {};
  for (const [name, field] of [['before', 'before_sources'], ['after', 'implementation_sources']]) {
    closures[name] = [];
    const expected = registration[name === 'before' ? 'before_implementation' : 'implementation'].files;
    assert.equal(registration[field].length, expected.length);
    for (const file of registration[field]) {
      const identity = expected.filter(row => row.path === file.path); assert.equal(identity.length, 1);
      assert.equal(file.sha256, identity[0].sha256); assert.equal(file.bytes, identity[0].bytes);
      assert.equal(file.archive.sha256, file.sha256); assert.equal(file.archive.bytes, file.bytes);
      const archived = await read(file.archive, file.path.endsWith('.json') ? 'json' : 'text');
      closures[name].push({ path: file.path, source_sha256: file.sha256, source_bytes: file.bytes, document: archived.document });
    }
  }
  // Inputs include private oracles/model configuration: bind their hashes for
  // stability but NEVER add their contents to the public document collection.
  for (const ref of registration.frozen_inputs.files) await retained(ref);
  for (const repair of registration.repairs) {
    for (const ref of [repair.run, repair.shared, repair.runtime, ...repair.raw_artifacts, ...repair.original_partial_collection]) await retained(ref);
    assert.equal(prefixRows[repair.episode_started_seq - 1]?.type, 'episode_started');
    assert.equal(prefixRows[repair.episode_unresolved_seq - 1]?.type, 'episode_unresolved');
    assert.equal(prefixRows[repair.episode_unresolved_seq - 1]?.run_id, repair.run_id);
  }
  const materials = [];
  for (const binding of registration.material_bindings) {
    let item = materials.find(row => row.source_sha256 === binding.reference.sha256);
    if (!item) {
      const projected = await read(binding.reference), manifest = projected.value;
      assert.equal(manifest.kind, 'benchmark-material-ownership-projection'); assert.equal(manifest.schema_version, 1);
      const before = await read(manifest.original_proof), after = await read(manifest.projected_material.materialization_proof);
      for (const file of manifest.files) await retained({ path: file.owned_path, sha256: file.sha256, bytes: file.bytes });
      const native = manifest.original_material.skill_inventory.map((file, index) => {
        const sourceRelative = relative(manifest.original_material.skills_root, file.path).split(sep).join('/');
        const ownedRelative = relative(manifest.projected_material.skills_root, manifest.projected_material.skill_inventory[index].path).split(sep).join('/');
        assert.equal(sourceRelative, ownedRelative);
        return { skill_id: file.skill_id, resource_path: file.resource_path, source_relative_path: sourceRelative, owned_relative_path: ownedRelative, sha256: file.sha256 };
      });
      item = { source_sha256: binding.reference.sha256, manifest_document: projected.document, original_proof_document: before.document,
        projected_proof_document: after.document, native_relative_mappings: native, cases: [] }; materials.push(item);
    }
    item.cases.push({ case_id: binding.case_id, original_binding_source_sha256: binding.original_binding_sha256 });
  }
  return { registration, documents: [...documents.values()], index: { version: 1, kind: 'benchmark-public-collection-recovery-audit',
    experiment_id: plan.id, source_plan_file_sha256: planFile.sha256, source_plan_sha256: plan.plan_sha256,
    registration_source_sha256: reference.sha256, registration_semantic_source_sha256: registration.registration_sha256,
    registration_document: original.document, failure_ledger_document: ledgerDocument, source_closures: closures,
    materials, completed_run_ids: tagged.map(row => row.run_id),
    verification_scope: 'Public file hashes, retained failure correspondence, source-inventory claims and path-only proof projections. Private recovery, raw admission, grading and source hash chains are not rerun.',
    private_hash_boundary: 'source_sha256 values identify private originals; public_sha256 values verify these redacted copies. A private hash is not recomputed from public projected bytes.' } };
}

export function projectRecoveryAudit({ audit, sanitizer, packageName, publicManifest, descriptor }) {
  assert.ok(/^[a-z][a-z0-9-]{0,79}$/.test(packageName));
  const files = new Map(), documents = audit.documents.map(source => {
    let bytes;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(source.content);
    if (source.format === 'json') bytes = encode(sanitizer.walk(JSON.parse(text)));
    else if (source.format === 'jsonl') { assert.ok(text.endsWith('\n')); bytes = Buffer.from(text.trimEnd().split('\n').map(line => canonical(sanitizer.walk(JSON.parse(line)))).join('\n') + '\n'); }
    else { assert.equal(source.format, 'text'); bytes = Buffer.from(sanitizer.text(text, { filesystem: false })); }
    sanitizer.assertClean(bytes);
    const publicSha = sha(bytes), publicPath = 'recovery-audits/blobs/' + publicSha;
    if (files.has(publicPath)) assert.ok(files.get(publicPath).equals(bytes)); else files.set(publicPath, bytes);
    return { id: source.id, format: source.format, source_sha256: source.source_sha256, source_bytes: source.source_bytes,
      public_path: publicPath, public_sha256: publicSha, public_bytes: bytes.length, transformed: !bytes.equals(source.content) };
  });
  const index = { ...sanitizer.walk(audit.index), package: packageName, documents, repairs: [], audit_sha256: null };
  for (const repair of audit.registration.repairs) {
    const completed = index.completed_run_ids.includes(sanitizer.text(repair.run_id));
    const artifacts = repair.raw_artifacts.map(raw => {
      const mapping = publicManifest.raw_mapping.find(row => row.source_sha256 === raw.sha256);
      if (completed) assert.ok(mapping, 'Completed recovery raw artifact is absent from its public subpackage');
      return { id: sanitizer.text(raw.id), source_sha256: raw.sha256, source_bytes: raw.bytes,
        public_copy: mapping ? { path: packageName + '/' + mapping.public_path, sha256: mapping.public_sha256, bytes: mapping.public_bytes } : null };
    });
    index.repairs.push({ run_id: sanitizer.text(repair.run_id), slot_id: sanitizer.text(repair.slot_id),
      state: completed ? 'completed_from_same_raw' : 'registered_not_completed', reservation_source_sha256: repair.reservation.sha256,
      episode_started_seq: repair.episode_started_seq, episode_unresolved_seq: repair.episode_unresolved_seq,
      raw_inventory: artifacts });
  }
  index.audit_sha256 = sha(canonical(index));
  const indexPath = 'recovery-audits/' + packageName + '/audit.json', bytes = encode(index);
  sanitizer.assertClean(bytes); files.set(indexPath, bytes);
  const reference = { path: indexPath, sha256: sha(bytes), bytes: bytes.length, audit_sha256: index.audit_sha256 };
  const completedDescriptor = { ...descriptor, collection_recovery_audit: reference };
  verifyPublicRecoveryAudit({ index, descriptor: completedDescriptor, publicManifest, files });
  return { index, reference, files };
}

// Pure verifier shared by in-memory tests, assembly and the public offline
// replay. It never executes the archived repair sources or follows source paths.
export function verifyPublicRecoveryAudit({ index, descriptor, publicManifest, files }) {
  const auditRef = descriptor.collection_recovery_audit; assert.ok(auditRef); member(auditRef.path);
  const auditBytes = files.get(auditRef.path); assert.ok(Buffer.isBuffer(auditBytes));
  assert.equal(sha(auditBytes), auditRef.sha256); assert.equal(auditBytes.length, auditRef.bytes); assert.deepEqual(parse(auditBytes), index);
  assert.equal(auditRef.audit_sha256, index.audit_sha256);
  assert.equal(index.version, 1); assert.equal(index.kind, 'benchmark-public-collection-recovery-audit');
  assert.equal(index.audit_sha256, sha(canonical({ ...index, audit_sha256: null })));
  assert.equal(index.experiment_id, descriptor.experiment_id); assert.equal(index.package, descriptor.path);
  assert.equal(index.source_plan_file_sha256, descriptor.source_plan_file_sha256); assert.equal(index.source_plan_sha256, descriptor.source_plan_sha256);
  assert.equal(index.registration_source_sha256, descriptor.collection_recovery_source_sha256);
  const docs = new Map();
  for (const doc of index.documents) {
    assert.ok(!docs.has(doc.id)); member(doc.public_path); const bytes = files.get(doc.public_path); assert.ok(Buffer.isBuffer(bytes));
    assert.equal(sha(bytes), doc.public_sha256); assert.equal(bytes.length, doc.public_bytes);
    assert.ok(/^[a-f0-9]{64}$/.test(doc.source_sha256)); docs.set(doc.id, { ...doc, content: bytes });
  }
  const document = (id, expectedSha = null) => { const doc = docs.get(id); assert.ok(doc, 'Recovery audit document is missing'); if (expectedSha) assert.equal(doc.source_sha256, expectedSha); return doc; };
  const registrationDoc = document(index.registration_document, index.registration_source_sha256), registration = parse(registrationDoc.content);
  assert.equal(registration.kind, 'benchmark-collection-recovery'); assert.equal(registration.registration_sha256, index.registration_semantic_source_sha256);
  assert.equal(registration.plan.sha256, index.source_plan_file_sha256); assert.equal(registration.plan.plan_sha256, index.source_plan_sha256);
  assert.deepEqual(index.completed_run_ids.slice().sort(), descriptor.controller.completed.map(row => {
    assert.equal(row.collection_recovery_source_sha256, index.registration_source_sha256); return row.run_id;
  }).sort());
  const prefixDoc = document(index.failure_ledger_document, registration.ledger_prefix.sha256);
  assert.equal(prefixDoc.source_bytes, registration.ledger_prefix.bytes); assert.equal(prefixDoc.format, 'jsonl');
  const prefix = prefixDoc.content.toString('utf8'); assert.ok(prefix.endsWith('\n'));
  const rows = prefix.trimEnd().split('\n').map(JSON.parse); assert.equal(rows.length, registration.ledger_prefix.through_seq);
  for (const [i, row] of rows.entries()) assert.equal(row.seq, i + 1);
  for (const [name, field, impl] of [['before', 'before_sources', 'before_implementation'], ['after', 'implementation_sources', 'implementation']]) {
    const closure = index.source_closures[name]; assert.equal(closure.length, registration[field].length);
    assert.equal(closure.length, registration[impl].files.length);
    assert.equal(new Set(closure.map(file => file.path)).size, closure.length);
    assert.deepEqual(closure.map(file => file.path).sort(), registration[impl].files.map(file => file.path).sort());
    for (const file of closure) {
      const raw = registration[field].filter(item => item.path === file.path); assert.equal(raw.length, 1);
      const source = registration[impl].files.filter(item => item.path === file.path); assert.equal(source.length, 1);
      assert.equal(file.source_sha256, raw[0].sha256); assert.equal(file.source_sha256, source[0].sha256); assert.equal(file.source_sha256, raw[0].archive.sha256);
      assert.equal(file.source_bytes, raw[0].bytes); assert.equal(document(file.document, file.source_sha256).source_bytes, file.source_bytes);
    }
  }
  assert.equal(index.repairs.length, registration.repairs.length);
  for (const repair of index.repairs) {
    const original = registration.repairs.filter(item => item.run_id === repair.run_id); assert.equal(original.length, 1); const raw = original[0];
    for (const key of ['run_id', 'slot_id', 'episode_started_seq', 'episode_unresolved_seq']) assert.equal(repair[key], raw[key]);
    const start = rows[repair.episode_started_seq - 1], failed = rows[repair.episode_unresolved_seq - 1];
    assert.equal(start.type, 'episode_started'); assert.equal(failed.type, 'episode_unresolved');
    assert.equal(start.run_id, repair.run_id); assert.equal(failed.run_id, repair.run_id); assert.equal(start.slot_id, repair.slot_id);
    assert.deepEqual(failed.error, raw.original_error); assert.equal(repair.reservation_source_sha256, raw.reservation.sha256);
    assert.equal(repair.state, index.completed_run_ids.includes(repair.run_id) ? 'completed_from_same_raw' : 'registered_not_completed');
    assert.equal(repair.raw_inventory.length, raw.raw_artifacts.length);
    assert.equal(new Set(repair.raw_inventory.map(item => item.id)).size, repair.raw_inventory.length);
    assert.deepEqual(repair.raw_inventory.map(item => item.id).sort(), raw.raw_artifacts.map(item => item.id).sort());
    for (const item of repair.raw_inventory) {
      const source = raw.raw_artifacts.filter(artifact => artifact.id === item.id); assert.equal(source.length, 1);
      assert.equal(item.source_sha256, source[0].sha256); assert.equal(item.source_bytes, source[0].bytes);
      const mapped = publicManifest.raw_mapping.find(row => row.source_sha256 === item.source_sha256);
      if (repair.state === 'completed_from_same_raw') assert.ok(mapped);
      assert.deepEqual(item.public_copy, mapped ? { path: descriptor.path + '/' + mapped.public_path, sha256: mapped.public_sha256, bytes: mapped.public_bytes } : null);
    }
  }
  const cases = [];
  for (const item of index.materials) {
    const materialDoc = document(item.manifest_document, item.source_sha256), material = parse(materialDoc.content);
    assert.equal(material.kind, 'benchmark-material-ownership-projection');
    const beforeDoc = document(item.original_proof_document, material.original_proof.sha256), afterDoc = document(item.projected_proof_document, material.projected_material.materialization_proof.sha256);
    const before = parse(beforeDoc.content), after = parse(afterDoc.content);
    assert.equal(material.original_material.materialization_proof.sha256, beforeDoc.source_sha256);
    assert.deepEqual(material.original_material.skill_inventory, before.files);
    assert.deepEqual(material.projected_material.skill_inventory, after.files);
    assert.equal(material.original_material.skills_root, before.native_skill_root);
    assert.equal(material.projected_material.skills_root, after.native_skill_root);
    const expected = structuredClone(before), mappings = material.path_mappings.filter(row => row.document === 'proof');
    assert.ok(mappings.length > 0);
    const pointers = new Set();
    for (const mapping of mappings) {
      assert.ok(/^\/(?:canonical_to_actual\/\d+\/(?:(?:canonical_source|prepared_source|actual_source|receipt|raw_receipt)\/path|public_sdk_path)|files\/\d+\/path|native_root|native_skill_root)$/.test(mapping.pointer), 'Recovery projection can change only typed material paths');
      assert.ok(!pointers.has(mapping.pointer)); pointers.add(mapping.pointer);
      assert.equal(typeof mapping.origin_path, 'string'); assert.equal(typeof mapping.owned_path, 'string');
      assert.equal(pointerValue(before, mapping.pointer), mapping.origin_path); assert.equal(pointerValue(after, mapping.pointer), mapping.owned_path); replacePointer(expected, mapping.pointer, mapping.owned_path);
    }
    assert.deepEqual(expected, after, 'Public recovery proof changed a non-path fact');
    assert.equal(item.native_relative_mappings.length, material.native_relative_paths.length);
    for (const [i, row] of item.native_relative_mappings.entries()) {
      assert.equal(row.source_relative_path, row.owned_relative_path); member(row.source_relative_path);
      assert.equal(row.source_relative_path, material.native_relative_paths[i].relative_path);
      assert.equal(material.native_relative_paths[i].unchanged, true);
      for (const key of ['skill_id', 'resource_path']) { assert.equal(row[key], material.original_material.skill_inventory[i][key]); assert.equal(row[key], material.native_relative_paths[i][key]); }
      assert.equal(row.sha256, material.original_material.skill_inventory[i].sha256);
      assert.equal(row.sha256, material.projected_material.skill_inventory[i].sha256);
    }
    for (const row of item.cases) { cases.push(row.case_id); const registered = registration.material_bindings.filter(entry => entry.case_id === row.case_id); assert.equal(registered.length, 1); assert.equal(registered[0].reference.sha256, item.source_sha256); assert.equal(registered[0].original_binding_sha256, row.original_binding_source_sha256); }
  }
  assert.deepEqual(cases.sort(), registration.material_bindings.map(row => row.case_id).sort());
  assert.equal(new Set(cases).size, cases.length);
  return { status: 'verified', experiment_id: index.experiment_id, completed_runs: index.completed_run_ids.length, repairs: index.repairs.length,
    material_projections: index.materials.length, source_documents: docs.size, model_requests: 0, private_hashes_recomputed: false };
}

export function verifyRecoveryAccounting({ audits, accounting }) {
  for (const audit of audits) {
    const rows = accounting.episodes.filter(row => row.experiment_id === audit.experiment_id);
    for (const runId of audit.completed_run_ids) {
      const matches = rows.filter(row => row.run_id === runId); assert.equal(matches.length, 1, 'Recovery must keep one physical accounting row');
      assert.equal(matches[0].state, 'completed'); assert.equal(matches[0].collection_recovery_source_sha256, audit.registration_source_sha256);
      assert.equal(matches[0].collection_recovery_originally_unresolved, audit.repairs.some(repair => repair.run_id === runId));
    }
    for (const repair of audit.repairs) {
      const matches = rows.filter(row => row.run_id === repair.run_id); assert.equal(matches.length, 1, 'Recovery original reservation is absent or duplicated');
      assert.equal(matches[0].reservation_source_sha256, repair.reservation_source_sha256);
      assert.equal(matches[0].slot_id, repair.slot_id);
      if (repair.state === 'registered_not_completed') {
        assert.equal(matches[0].state, 'started_unresolved');
        for (const key of ['actual_model_http_requests', 'complete_input_tokens', 'complete_output_tokens', 'duration_ms']) assert.equal(matches[0][key], null);
      }
    }
  }
  return { audited_plans: audits.length, physical_runs_duplicated: 0 };
}
