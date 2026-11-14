import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
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
  keys(value, ['version', 'remote_writes', 'author_content', 'retention'], 'Versioned consumption effects');
  assert.equal(value.version, 1);
  assert.ok(['none', 'retained', 'unknown'].includes(value.remote_writes));
  assert.ok(['unchanged', 'unknown'].includes(value.author_content));
  assert.ok(Array.isArray(value.retention));
  for (const entry of value.retention) {
    keys(entry, ['skill_page_id', 'file_id', 'operation_id', 'status'], 'Exact retention owner and operation');
    for (const field of ['skill_page_id', 'file_id', 'operation_id']) assert.ok(typeof entry[field] === 'string' && entry[field]);
    assert.ok(['confirmed', 'unknown'].includes(entry.status));
  }
  if (value.remote_writes === 'none') {
    assert.equal(value.retention.length, 0); assert.equal(value.author_content, 'unchanged');
  }
  if (value.remote_writes === 'retained') {
    assert.ok(value.retention.length > 0); assert.ok(value.retention.every(entry => entry.status === 'confirmed'));
  }
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

/** Every compacted generated directory must have an intact same-identity copy
 * in this actual request. This independently checks the projector's omissions. */
export function verifyGeneratedDirectoryReuse(messages) {
  const present = new Set(), omitted = [], counts = new Map();
  const key = (binding, sha256, bytes) => {
    assert.ok(object(binding) && object(binding.record));
    for (const field of ['scope', 'snapshot_id', 'version_id']) assert.ok(typeof binding[field] === 'string' && binding[field]);
    assert.ok(typeof binding.record.id === 'string' && binding.record.id);
    return JSON.stringify([binding.scope, binding.record.id, binding.snapshot_id, binding.version_id, sha256, bytes]);
  };
  const complete = (binding, directory) => {
    const text = JSON.stringify(directory), id = key(binding, hash(text), Buffer.byteLength(text));
    present.add(id); counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.isError || !message.toolCallId) continue;
    const content = typeof message.content === 'string' ? message.content
      : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (['notion_use', 'skill_prepare'].includes(message.toolName) && message.details?.contextBrokerPreparation?.version === 2) {
      const verified = verifyPreparationEvidence(content, message.details.contextBrokerPreparation, message.toolCallId);
      for (const record of verified.records) {
        if (record.omittedDirectory) omitted.push(key(record.receipt.binding, record.omittedDirectory.sha256, record.omittedDirectory.bytes));
        else if (record.model.directory !== undefined) complete(record.receipt.binding, record.model.directory);
      }
    } else if (message.toolName === 'read') {
      const proof = message.details?.contextBrokerRead;
      if (proof?.version !== 3 || !proof.rendered || !proof.binding) continue;
      assert.equal(proof.toolCallId, message.toolCallId);
      measure(proof.rendered, content, 'Native directory reuse belongs to the exact output');
      if (proof.directoryOmitted !== undefined) {
        keys(proof.directoryOmitted, ['sha256', 'bytes'], 'Native directory omission');
        assert.match(proof.directoryOmitted.sha256, /^[a-f0-9]{64}$/u);
        assert.ok(Number.isSafeInteger(proof.directoryOmitted.bytes) && proof.directoryOmitted.bytes > 0);
        omitted.push(key(proof.binding, proof.directoryOmitted.sha256, proof.directoryOmitted.bytes));
        continue;
      }
      if (proof.loaded === false) continue;
      const end = proof.delivery?.end;
      assert.ok(proof.delivery?.start === 0 && proof.delivery?.encoding === 'raw' && Number.isSafeInteger(end) && end > 0);
      const body = content.slice(0, end);
      assert.equal(hash(body), proof.bodySha256); assert.equal(Buffer.byteLength(body), proof.bytes);
      let suffix = content.slice(end);
      if (message.details.effects !== undefined) {
        const footer = '\n\n<notion-effects>' + JSON.stringify(verifyConsumptionEffects(message.details.effects)) + '</notion-effects>';
        assert.ok(suffix.endsWith(footer)); suffix = suffix.slice(0, -footer.length);
      }
      const match = /^\n{2,3}<skill-directory>\n([\s\S]*)\n<\/skill-directory>$/.exec(suffix);
      if (!match) continue;
      const value = JSON.parse(match[1]); keys(value, ['ref', 'directory'], 'Complete native directory');
      assert.equal(JSON.stringify(value), match[1]);
      verifyPublicDirectory(value.directory, proof.directory);
      complete(proof.binding, value.directory);
    }
  }
  for (const id of omitted) assert.ok(present.has(id), 'An omitted directory has no complete witness in this request');
  for (const count of counts.values()) assert.equal(count, 1, 'A generated directory is duplicated in this request');
  return { completeDirectories: present.size, omittedDirectories: omitted.length };
}

/** Inspect actual complete tool text independently of the request projection.
 * The caller still authenticates the selected binding against its source oracle.
 * These cards are evidence only while this very text remains in the request. */
export function generatedCatalogCards(message) {
  assert.equal(message?.role, 'toolResult'); assert.notEqual(message.isError, true);
  assert.ok(typeof message.toolCallId === 'string' && message.toolCallId.length > 0);
  const parts = typeof message.content === 'string' ? [message.content]
    : (message.content ?? []).map(part => { assert.equal(part.type, 'text'); assert.equal(typeof part.text, 'string'); return part.text; });
  const content = parts.join('\n');
  let records;
  if (message.toolName === 'notion_use') {
    const verified = verifyPreparationEvidence(content, message.details?.contextBrokerPreparation, message.toolCallId);
    assert.equal(verified.model.purpose, 'use');
    records = verified.records.filter(record => record.mapping.state === 'source').map(record => ({
      receipt: record.receipt, directory: record.model.directory, body: record.decodedContent,
    }));
  } else {
    assert.equal(message.toolName, 'read');
    const receipt = message.details?.contextBrokerRead, span = receipt?.delivery;
    assert.equal(receipt?.version, 3); assert.notEqual(receipt.loaded, false);
    assert.equal(receipt.toolCallId, message.toolCallId); assert.equal(span?.start, 0); assert.equal(span?.encoding, 'raw');
    assert.ok(Number.isSafeInteger(span.end) && span.end > 0 && span.end <= content.length);
    const body = content.slice(0, span.end);
    assert.equal(hash(body), receipt.bodySha256); assert.equal(Buffer.byteLength(body), receipt.bytes);
    let suffix = content.slice(span.end);
    if (message.details.effects !== undefined) {
      const effects = verifyConsumptionEffects(message.details.effects);
      const footer = '\n\n<notion-effects>' + JSON.stringify(effects) + '</notion-effects>';
      assert.ok(suffix.endsWith(footer), 'Effects metadata must match the exact generated suffix');
      suffix = suffix.slice(0, -footer.length);
    }
    const footer = /^\n{2,3}<skill-directory>\n([\s\S]*)\n<\/skill-directory>$/.exec(suffix);
    assert.ok(footer, 'Only the generated suffix after the complete author span supplies cards');
    const model = JSON.parse(footer[1]); keys(model, ['ref', 'directory'], 'Native generated directory');
    assert.equal(footer[1], JSON.stringify(model));
    assert.match(model.ref, /^sr:S[A-Za-z0-9_-]{22}$/u);
    records = [{ receipt, directory: model.directory, body }];
  }
  return records.flatMap(({ receipt, directory, body }) => {
    const binding = receipt.binding, identity = JSON.parse(receipt.identity);
    assert.ok(object(binding) && object(binding.record) && Array.isArray(identity) && identity.length === 5);
    assert.ok(typeof identity[0] === 'string' && identity[0].length > 0);
    assert.match(binding.scope, /^[a-f0-9]{64}$/u); assert.equal(identity[1], binding.scope);
    assert.equal(identity[2], binding.record.kind); assert.equal(identity[3], binding.record.locator?.type);
    assert.equal(identity[4], binding.record.id); assert.equal(binding.snapshot_id, receipt.snapshotId);
    assert.equal(binding.body_sha256, receipt.bodySha256); assert.equal(hash(body), binding.body_sha256);
    if (directory === undefined) return [];
    verifyPublicDirectory(directory, receipt.directory);
    const result = [];
    for (const group of ['files', 'required', 'candidates', 'references']) {
      const canonical = receipt.directory?.[group];
      assert.ok(Array.isArray(directory[group]) && Array.isArray(canonical));
      assert.equal(directory[group].length, canonical.length);
      for (const [index, card] of directory[group].entries()) {
        const original = canonical[index];
        assert.equal(typeof card.ref, 'string'); assert.equal(typeof original?.ref, 'string');
        if (group === 'files' || !Object.hasOwn(card, 'kind')) continue;
        for (const key of ['kind', 'name', 'description', 'availability']) assert.equal(typeof card[key], 'string');
        assert.equal(typeof original.id, 'string');
        // A selected/fixed relation is not a current discovery card, even for the
        // same owner. The exact current handle and canonical owner are both kept.
        if (!/^sr:C[A-Za-z0-9_-]{22}$/u.test(card.ref) || original.ref.includes('?')) continue;
        result.push({ ...card, id: original.id, canonical_ref: original.ref, source: identity[0], scope: binding.scope,
          binding, body_sha256: hash(body), body_bytes: Buffer.byteLength(body), tool_call_id: message.toolCallId,
          tool_name: message.toolName, tool_content_sha256: hash(content) });
      }
    }
    return result;
  });
}

export function generatedDescriptionEvidence(messages, expected, matchesBinding) {
  if (!/^sr:C[A-Za-z0-9_-]{22}$/u.test(expected.ref) || typeof matchesBinding !== 'function') return undefined;
  for (const message of messages) {
    let cards;
    try { cards = generatedCatalogCards(message); } catch { continue; }
    const matches = cards.filter(card => ['ref', 'id', 'scope', 'source', 'kind', 'name', 'description', 'availability'].every(key => card[key] === expected[key])
      && card.canonical_ref === expected.canonical_ref && matchesBinding(card.binding, card.body_sha256, card.body_bytes));
    // Relation groups and complete roots may share the same current card.
    if (matches.length === 0) continue;
    const { binding: _binding, ...card } = matches[0];
    return { origin: 'complete-generated-directory', ...card };
  }
  return undefined;
}

/** Observe source receipts before Pi converts custom messages to provider user
 * text. Persisted authority comes only from the current effective projection. */
export function captureInjectionReceipts(messages, projection) {
  const text = content => typeof content === 'string' ? content
    : Array.isArray(content) && content.every(part => part.type === 'text') ? content.map(part => part.text).join('\n') : '';
  const direct = messages.filter(message => message.role === 'custom' && message.customType === 'context-broker'
    && Array.isArray(message.details?.records) && text(message.content)).map(message => {
    const content = text(message.content);
    return { content_sha256: createHash('sha256').update(content).digest('hex'), content_bytes: Buffer.byteLength(content), details: message.details };
  });
  const projectionAvailable = Array.isArray(projection?.entries);
  const persisted = (projection?.entries ?? []).map(entry => entry.sourceEntry).filter(entry => entry?.type === 'custom'
    && entry.customType === 'context-broker' && Array.isArray(entry.data?.records)
    && typeof entry.data.nativePromptSha256 === 'string').map(entry => ({ entry_id: entry.id, data: entry.data }));
  return { projection_available: projectionAvailable, direct, persisted };
}

/** Verify native source spans against this request and the caller's existing
 * source oracle. Receipts remain outside the provider payload. */
export function injectedDescriptionEvidence(messages, expected, resolveSource, injectionContext) {
  if (!/^sr:C[A-Za-z0-9_-]{22}$/u.test(expected.ref) || typeof resolveSource !== 'function') return undefined;
  const textContent = content => typeof content === 'string' ? content
    : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const receipts = messages.filter(message => message.role === 'custom' && message.customType === 'context-broker')
    .map(message => ({ message, details: message.details }));
  for (const receipt of injectionContext?.direct ?? []) receipts.push({ ...receipt, receipt_source: 'native-custom' });
  for (const receipt of injectionContext?.persisted ?? []) receipts.push({ details: receipt.data,
    entry_id: receipt.entry_id, receipt_source: 'native-session' });
  for (const receipt of receipts) {
    if (!Array.isArray(receipt.details?.records)) continue;
    const promptHash = receipt.details.nativePromptSha256, expectedHash = receipt.content_sha256 ?? promptHash;
    const matching = expectedHash === undefined ? [] : messages.filter(candidate => candidate.role === 'user'
      && hash(textContent(candidate.content)) === expectedHash);
    const delivered = expectedHash === undefined ? receipt.message : matching.length === 1 ? matching[0] : undefined;
    if (!delivered || Array.isArray(delivered.content) && delivered.content.some(part => part.type !== 'text')) continue;
    const content = textContent(delivered.content);
    if (receipt.receipt_source === 'native-custom' && Buffer.byteLength(content) !== receipt.content_bytes) continue;
    if (receipt.receipt_source === 'native-custom' && promptHash !== undefined && promptHash !== expectedHash) continue;
    for (const proof of receipt.details.records) {
      try {
        assert.equal(proof.version, 2); assert.equal(proof.loaded, true); assert.equal(proof.sourceId, expected.source);
        const binding = proof.binding, snapshot = resolveSource(binding, { content, proof });
        assert.ok(snapshot, 'The native receipt needs one independently observed source binding');
        const main = snapshot.files.find(file => file.path === snapshot.entrypoint || file.path === snapshot.record.entrypoint);
        assert.equal(binding.scope, expected.scope); assert.deepEqual(binding.record, snapshot.record);
        assert.equal(proof.snapshotId, snapshot.snapshot_id); assert.equal(proof.versionId, snapshot.version_id);
        assert.equal(proof.bodySha256, main.sha256); assert.equal(proof.bytes, main.bytes); assert.equal(binding.body_sha256, main.sha256);
        assert.equal(proof.contentIdentity, JSON.stringify([binding.scope, binding.record.id]));
        assert.equal(proof.identity, JSON.stringify([expected.source, binding.scope, binding.record.kind, binding.record.locator.type, binding.record.id]));
        const ref = new URL(binding.ref), current = new URL(snapshot.record.ref);
        assert.equal(ref.protocol, 'skill:'); assert.equal(ref.host, current.host); assert.equal(ref.pathname, current.pathname);
        assert.equal(ref.username, ''); assert.equal(ref.password, ''); assert.equal(ref.hash, '');
        assert.equal(ref.searchParams.get('snapshot'), snapshot.snapshot_id);
        assert.ok([...ref.searchParams.keys()].every(key => ['snapshot', 'file_id'].includes(key)));
        assert.equal(ref.searchParams.getAll('snapshot').length, 1); assert.ok(ref.searchParams.getAll('file_id').length <= 1);
        if (ref.searchParams.has('file_id')) assert.equal(ref.searchParams.get('file_id'), snapshot.file_bindings?.find(file => file.path === main.path)?.file_id);
        const { start, end, encoding } = proof.delivery;
        assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= content.length);
        assert.ok(['raw', 'xml', 'json'].includes(encoding));
        const span = content.slice(start, end), body = encoding === 'xml'
          ? span.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
          : encoding === 'json' ? JSON.parse('"' + span + '"') : span;
        assert.equal(hash(body), main.sha256); assert.equal(Buffer.byteLength(body), main.bytes);
        const fields = ['id', 'ref', 'kind', 'name', 'description', 'availability'];
        for (const candidate of proof.directory?.candidates ?? []) {
          if (!candidate || typeof candidate !== 'object' || Object.keys(candidate).length !== fields.length
            || fields.some(key => typeof candidate[key] !== 'string' || candidate[key] !== expected[key === 'ref' ? 'canonical_ref' : key])) continue;
          const row = `- [${candidate.name}](${candidate.ref}) — ${candidate.description}`, at = body.indexOf(row), after = at + row.length;
          if (at < 0 || at > 0 && body[at - 1] !== '\n' || after !== body.length && body[after] !== '\n' && body.slice(after, after + 2) !== '\r\n') continue;
          return { origin: 'actual-injected-member', id: expected.id, ref: expected.ref, description: expected.description, source: expected.source,
            scope: expected.scope, owner: snapshot.record.id, snapshot_id: snapshot.snapshot_id, body_sha256: main.sha256,
            body_bytes: main.bytes, body_start: start, body_end: end, ...(promptHash === undefined ? {} : { native_prompt_sha256: promptHash }),
            ...(receipt.receipt_source ? { receipt_source: receipt.receipt_source, native_context_monotonic_ns: injectionContext.monotonic_ns,
              ...(receipt.entry_id ? { native_receipt_entry_id: receipt.entry_id } : {}) } : {}) };
        }
      } catch { /* Only an independently verified complete body can support omission. */ }
    }
  }
  return undefined;
}

/** Structural validation only: absent descriptions still need a separate
 * same-request witness. The returned rows contain actual visible descriptions. */
export function visibleDiscoveryCards(message) {
  assert.equal(message?.role, 'toolResult'); assert.equal(message.toolName, 'notion_list'); assert.notEqual(message.isError, true);
  const content = typeof message.content === 'string' ? message.content : message.content.map(part => {
    assert.equal(part.type, 'text'); return part.text;
  }).join('\n');
  const model = JSON.parse(content), full = message.details;
  assert.equal(content, JSON.stringify(model)); assert.equal(full?.ok, true); assert.equal(full.state, 'known');
  assert.ok(Array.isArray(full.records) && Array.isArray(model.records)); assert.equal(model.records.length, full.records.length);
  const expected = { ...full, records: full.records.map((record, index) => {
    assert.ok(typeof record.id === 'string' && typeof record.scope === 'string');
    const { id, scope, ...card } = record;
    if (!Object.hasOwn(model.records[index], 'description')) delete card.description;
    return card;
  }) };
  assert.deepEqual(model, expected, 'Discovery projection may omit only the description after id and scope');
  return model.records.flatMap((record, index) => Object.hasOwn(record, 'description')
    ? [{ ...record, id: full.records[index].id, scope: full.records[index].scope, tool_call_id: message.toolCallId,
      tool_content_sha256: hash(content) }] : []);
}
