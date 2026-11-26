import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from './protocol.mjs';
import { catalogFacets, graphSourceViews, retainedMaterialSelection, retainedSelectionSnapshots, RETAINED_SOURCE_CONTRACT } from './retained-source-views.mjs';
import { preparedSourceMatches, preparedSourceMatchKind } from './collect.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const measure = value => ({ sha256: hash(value), bytes: Buffer.byteLength(value) });
const library = '11111111-1111-4111-8111-111111111111';
const libraryOwner = 'skill://eligibility?library=' + library;

// The retained SDK-v2 read-resources/consume shapes, with synthetic identities
// and bodies. These are source receipts, independent of the product compiler.
function fixture() {
  const owner = 'shared_skill:fixture:eligibility', scope = hash('scope'), snapshot = 's_' + hash('snapshot'), version = hash('version');
  const main = '# Eligibility\nRead the exact resource.\n', body = 'Complete rules.\n条件：已验证。\n', path = 'references/eligibility.md';
  const fixed = (path, fileId) => 'skill://' + encodeURIComponent(owner) + '/' + path + '?snapshot=' + snapshot + (fileId ? '&file_id=' + fileId : '');
  const record = { id: owner, kind: 'skill', locator: { type: 'shared_skill' }, entrypoint: 'SKILL.md', ref: fixed('SKILL.md', 'main-file') };
  const manifest = { complete: true, scope, snapshot_id: snapshot, version_id: version, record, entrypoint: 'SKILL.md',
    files: [{ path: 'SKILL.md', ref: record.ref, ...measure(main) }, { path, ref: fixed(path, 'resource-file'), ...measure(body) }],
    file_bindings: [{ path: 'SKILL.md', file_id: 'main-file', page_id: 'main-page' }, { path, file_id: 'resource-file', page_id: 'resource-page' }] };
  const selection = { scope, owner, snapshot_id: snapshot, version_id: version };
  const resource = { version: 1, status: 'ready', manifest, manifest_sha256: hash(canonicalJson(manifest)), selection,
    files: [{ requested_ref: fixed(path), ref: fixed(path, 'resource-file'), file_id: 'resource-file', path, ...measure(body), encoding: 'utf8', content: body }] };
  const node = { id: 'prepared-root', state: 'prepared', record, path: 'SKILL.md', content: main, body_sha256: hash(main), bytes: Buffer.byteLength(main),
    binding: { snapshot_id: snapshot, version_id: version, ref: record.ref } };
  const source_body = { kind: 'verified_snapshot_entry', ref: record.ref, path: 'SKILL.md', has_more: false,
    range: { start: 1, end: main.split('\n').length, total_lines: main.split('\n').length }, ...measure(main) };
  const consume = { version: 1, status: 'ready', preparation: { status: 'ready', scope, nodes: [node] }, entries: [{ id: node.id, manifest,
    manifest_sha256: hash(canonicalJson(manifest)), source_body, materialization: { status: 'entry_ready', paths: ['SKILL.md'] },
    projection: { status: 'identity', compiler: 'source-identity/v1', source_body_sha256: hash(main), projection_sha256: hash(main), bytes: Buffer.byteLength(main) } }] };
  const receipt = (operation, value) => ({ version: 2, transport: 'sdk', requestId: 'observed-' + operation,
    operation, status: 'completed', resultObserved: true, value });
  return { owner, scope, snapshot, version, main, body, path, record, manifest, resource: receipt('read-resources', resource), consume: receipt('consume', consume), receipt };
}

test('retained SDK-v2 views preserve exact original bodies, manifests and operation identities', () => {
  const f = fixture(), receipts = [f.consume, f.resource], original = JSON.stringify(receipts), views = graphSourceViews(receipts);
  assert.equal(RETAINED_SOURCE_CONTRACT, 'notion-sdk-v2/resource-read-v1/skill-ref-v1/preparation-evidence-v2');
  assert.equal(views.entries.length, 1); assert.equal(views.preparations.length, 1); assert.equal(views.resources.length, 1);
  assert.equal(views.entries[0].value.content, f.main); assert.equal(views.entries[0].value.record.id, f.owner);
  assert.equal(views.entries[0].requestId, f.consume.requestId); assert.equal(views.entries[0].operation, 'consume');
  assert.deepEqual(views.resources[0].value, f.resource.value); assert.equal(JSON.stringify(receipts), original);
  for (const encoding of ['utf8', 'base64']) {
    const changed = structuredClone(f.resource), file = changed.value.files[0];
    file.requested_ref = file.ref; file.encoding = encoding; file.content = Buffer.from(f.body).toString(encoding);
    assert.equal(graphSourceViews([changed]).resources.length, 1, encoding);
  }
  for (const change of [{ resultObserved: false }, { status: 'failed' }]) {
    const absent = graphSourceViews(receipts.map(receipt => ({ ...receipt, ...change })));
    assert.equal(absent.entries.length, 0); assert.equal(absent.resources.length, 0);
  }
});

test('retained resource evidence binds owner, path, snapshot, version and stable file identity', () => {
  const mutations = [
    ['owner', value => { value.selection.owner = 'shared_skill:other'; }],
    ['scope', value => { value.selection.scope = hash('other scope'); }],
    ['snapshot', value => { value.selection.snapshot_id = 's_' + hash('other snapshot'); }],
    ['version', value => { value.selection.version_id = hash('other version'); }],
    ['path', value => { value.files[0].path = 'references/other.md'; }],
    ['resolved owner', value => { value.files[0].ref = value.files[0].ref.replace('eligibility', 'foreign'); }],
    ['requested owner', value => { value.files[0].requested_ref = value.files[0].requested_ref.replace('eligibility', 'foreign'); }],
    ['resolved snapshot', value => { value.files[0].ref = value.files[0].ref.replace(value.selection.snapshot_id, 's_' + hash('foreign')); }],
    ['requested snapshot', value => { value.files[0].requested_ref = value.files[0].requested_ref.replace(value.selection.snapshot_id, 's_' + hash('foreign')); }],
    ['resolved path', value => { value.files[0].ref = value.files[0].ref.replace('references/eligibility.md', 'references/other.md'); }],
    ['requested path', value => { value.files[0].requested_ref = value.files[0].requested_ref.replace('references/eligibility.md', 'references/other.md'); }],
    ['file binding', value => { value.files[0].file_id = 'other-file'; }],
    ['resolved file id', value => { value.files[0].ref = value.files[0].ref.replace('resource-file', 'other-file'); }],
    ['requested file id', value => { value.files[0].requested_ref += '&file_id=other-file'; }],
    ['duplicate file', value => { value.files.push(structuredClone(value.files[0])); }],
  ];
  for (const [name, mutate] of mutations) {
    const receipt = fixture().resource; mutate(receipt.value);
    assert.throws(() => graphSourceViews([receipt]), undefined, name);
  }
});

test('retained resource evidence rejects incomplete bytes or a changed manifest contract', () => {
  const mutations = [
    ['content', value => { value.files[0].content = value.files[0].content.slice(0, -1); }],
    ['hash', value => { value.files[0].sha256 = hash('other'); }],
    ['bytes', value => { value.files[0].bytes--; }],
    ['manifest hash', value => { value.manifest_sha256 = hash('other'); }],
    ['incomplete manifest', value => { value.manifest.complete = false; value.manifest_sha256 = hash(canonicalJson(value.manifest)); }],
    ['declared bytes', value => { value.manifest.files[1].bytes--; value.manifest_sha256 = hash(canonicalJson(value.manifest)); }],
    ['declared hash', value => { value.manifest.files[1].sha256 = hash('other'); value.manifest_sha256 = hash(canonicalJson(value.manifest)); }],
    ['manifest file id', value => { value.manifest.file_bindings[1].file_id = 'other-file'; value.manifest_sha256 = hash(canonicalJson(value.manifest)); }],
    ['resource version', value => { value.version = 2; }],
  ];
  for (const [name, mutate] of mutations) {
    const receipt = fixture().resource; mutate(receipt.value);
    assert.throws(() => graphSourceViews([receipt]), undefined, name);
  }
});

test('retained consume evidence still requires the entire prepared closure and complete original entry', () => {
  const mutations = [
    ['missing entry', value => { value.entries = []; }],
    ['manifest hash', value => { value.entries[0].manifest_sha256 = hash('other'); }],
    ['prepared bytes', value => { value.preparation.nodes[0].content += 'changed'; }],
    ['partial range', value => { value.entries[0].source_body.range.start = 2; }],
    ['has more', value => { value.entries[0].source_body.has_more = true; }],
    ['missing materialization', value => { value.entries[0].materialization.paths = []; }],
    ['projection hash', value => { value.entries[0].projection.projection_sha256 = hash('other'); }],
    ['consume version', value => { value.version = 2; }],
  ];
  for (const [name, mutate] of mutations) {
    const receipt = fixture().consume; mutate(receipt.value);
    assert.throws(() => graphSourceViews([receipt]), undefined, name);
  }
});

test('retained interpretation explicitly rejects protocol-v2 Library owners and references', () => {
  for (const operation of ['consume', 'resource']) {
    const f = fixture(), receipt = f[operation];
    f.record.id = libraryOwner;
    if (operation === 'resource') receipt.value.selection.owner = libraryOwner;
    const entries = operation === 'consume' ? receipt.value.entries : [receipt.value];
    for (const entry of entries) entry.manifest_sha256 = hash(canonicalJson(entry.manifest));
    assert.throws(() => graphSourceViews([receipt]), /Library-qualified owner/);
  }
  for (const key of ['ref', 'requested_ref']) {
    const receipt = fixture().resource; receipt.value.files[0][key] += '&library=' + library;
    assert.throws(() => graphSourceViews([receipt]), /Library-qualified reference/);
  }
  const f = fixture(), entry = f.consume.value.entries[0];
  entry.source_body.ref += '&library=' + library; f.consume.value.preparation.nodes[0].binding.ref = entry.source_body.ref;
  assert.throws(() => graphSourceViews([f.consume]), /Library-qualified reference/);
  for (const operation of ['list', 'read', 'prepare']) {
    const record = { ...f.record, id: libraryOwner };
    const value = operation === 'list' ? { scope: f.scope, records: [record], databases: [] }
      : operation === 'read' ? { scope: f.scope, record, content: f.main }
        : { status: 'ready', nodes: [{ record }] };
    assert.throws(() => graphSourceViews([f.receipt(operation, value)]), /Library-qualified owner/);
  }
});

test('retained catalog facets keep separate success and failure without creating source calls', () => {
  const f = fixture(), catalog = { scope: f.scope, records: [f.record], databases: [] };
  assert.deepEqual(catalogFacets(catalog), [{ facet: 'flat', ok: true, value: catalog }]);
  const value = { version: 1, catalog: { ok: true, value: catalog }, directory: { ok: false, error: { code: 'UNAVAILABLE', message: 'Not observed' } } };
  const views = graphSourceViews([f.receipt('list', value)]);
  assert.equal(views.directories.length, 1); assert.equal(views.directoryFailures.length, 1);
  assert.equal(views.directories[0].requestId, views.directoryFailures[0].requestId);
  assert.equal(views.entries.length, 0); assert.equal(views.resources.length, 0);
  for (const mutate of [v => { v.version = 2; }, v => { v.directory.value = catalog; }, v => { v.catalog.value.query = 'selected'; }]) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => graphSourceViews([f.receipt('list', changed)]));
  }
});

// Golden values obtained from the hash-pinned retained SDK implementation.
const selectionSnapshots = {
  record_bound: 's_74060fee7f485a657e10e6bd1319b47e2cedfee0f1e3a93acf88d759e5a5aa9e',
  legacy: 's_79d2156689ce53e8313c6c6003dbdcaf1c4e95f67b26923443be2b305ccb5891',
};
function materialSelectionFixture(snapshot = selectionSnapshots.legacy) {
  const f = fixture(), record = { id: f.owner, kind: 'skill',
    locator: { type: 'shared_skill', page_id: 'fixture-page', skill_id: 'eligibility' },
    entrypoint: 'SKILL.md', ref: 'skill://' + encodeURIComponent(f.owner) + '/SKILL.md' };
  const fixed = (path, id) => 'skill://' + encodeURIComponent(f.owner) + '/' + path + '?snapshot=' + snapshot + '&file_id=' + id;
  const files = f.manifest.files.map(file => ({ ...file, ref: fixed(file.path, f.manifest.file_bindings.find(binding => binding.path === file.path).file_id) }));
  const main = { ok: true, record, scope: f.scope, snapshot_id: snapshot, version_id: f.version, entrypoint: 'SKILL.md', path: 'SKILL.md', ref: files[0].ref,
    content: f.main, materialization: { manifest_complete: true }, file_bindings: structuredClone(f.manifest.file_bindings),
    has_more: false, range: { start: 1, end: f.main.split('\n').length, total_lines: f.main.split('\n').length } };
  const observed = files.map(({ ref, ...file }) => file);
  const raw = { main, directory: { ok: true, record: structuredClone(record), scope: f.scope, snapshot_id: snapshot, version_id: f.version,
    entrypoint: 'SKILL.md', ref: main.ref, materialization: { manifest_complete: true }, files,
    file_bindings: structuredClone(main.file_bindings) }, observedFiles: structuredClone(observed) };
  const receipt = { status: 'passed', object: { owner: f.owner, scope: f.scope, snapshot_id: snapshot, version_id: f.version },
    observed: { state: 'present', ready: true, files: structuredClone(observed) } };
  const proofIdentity = { bound_owner: f.owner, bound_skill_id: record.locator.skill_id, bound_page_id: record.locator.page_id,
    bound_versions: { v1: { ref: main.ref, snapshot_id: snapshot, version_id: f.version } } };
  const boundIdentity = { ...proofIdentity, bound_versions: { v1: { snapshot_id: 's_' + hash('stale snapshot'), version_id: hash('stale version') } } };
  const material = { path: f.path, ...measure(f.body) };
  return { ...f, record, raw, receipt, proofIdentity, boundIdentity, material,
    pack() {
      const rawBytes = Buffer.from(JSON.stringify(raw)), receiptBytes = Buffer.from(JSON.stringify({ ...receipt,
        rawEvidence: { sha256: hash(rawBytes), bytes: rawBytes.length } }));
      return { receiptBytes, rawBytes, material, boundIdentity, proofIdentity };
    } };
}

test('retained snapshot formulas reproduce both golden identities and preserve record field ordering independence', () => {
  const f = materialSelectionFixture();
  assert.deepEqual(retainedSelectionSnapshots(f.raw.main), selectionSnapshots);
  const reordered = { ...f.raw.main, record: Object.fromEntries(Object.entries(f.record).reverse()) };
  reordered.record.locator = Object.fromEntries(Object.entries(f.record.locator).reverse());
  assert.deepEqual(retainedSelectionSnapshots(reordered), selectionSnapshots);
  assert.notEqual(retainedSelectionSnapshots({ ...f.raw.main, record: { ...f.record, name: 'Changed metadata' } }).record_bound, selectionSnapshots.record_bound);
});

test('hash-linked complete material readbacks yield a selection without changing the stale case binding', () => {
  for (const snapshot of Object.values(selectionSnapshots)) {
    const f = materialSelectionFixture(snapshot), input = f.pack(), before = JSON.stringify(f.boundIdentity);
    const selected = retainedMaterialSelection(input);
    assert.ok(selected); assert.equal(selected.snapshot_id, snapshot); assert.equal(selected.material_version, 'v1');
    assert.equal(selected.owner, f.owner); assert.deepEqual(selected.record, f.record);
    assert.equal(selected.receipt_sha256, hash(input.receiptBytes)); assert.equal(selected.raw_receipt_sha256, hash(input.rawBytes));
    assert.equal(JSON.stringify(f.boundIdentity), before);
  }
});

test('material selection rejects unlinked, incomplete, ambiguous or foreign parity identities', () => {
  const mutations = [
    ['case owner', f => { f.boundIdentity.bound_owner = 'shared_skill:other'; }],
    ['case page', f => { f.boundIdentity.bound_page_id = 'foreign-page'; }],
    ['case skill', f => { f.boundIdentity.bound_skill_id = 'foreign-skill'; }],
    ['case named version', f => { f.boundIdentity.bound_versions = { v2: f.boundIdentity.bound_versions.v1 }; }],
    ['proof owner', f => { f.proofIdentity.bound_owner = 'shared_skill:other'; }],
    ['proof version', f => { f.proofIdentity.bound_versions.v1.version_id = hash('other'); }],
    ['ambiguous proof version', f => { f.proofIdentity.bound_versions.v2 = f.proofIdentity.bound_versions.v1; }],
    ['receipt selection', f => { f.receipt.object.scope = hash('other'); }],
    ['different raw record', f => { f.raw.directory.record.description = 'Changed'; }],
    ['different raw scope', f => { f.raw.directory.scope = hash('other'); }],
    ['different raw version', f => { f.raw.directory.version_id = hash('other'); }],
    ['incomplete manifest', f => { f.raw.directory.materialization.manifest_complete = false; }],
    ['partial body', f => { f.raw.main.has_more = true; }],
    ['partial range', f => { f.raw.main.range.start = 2; }],
    ['changed main bytes', f => { f.raw.main.content += 'changed'; }],
    ['changed resource bytes', f => { f.material.bytes--; }],
    ['changed resource hash', f => { f.material.sha256 = hash('other'); }],
    ['changed observed file', f => { f.raw.observedFiles[1].sha256 = hash('other'); }],
    ['missing receipt file', f => { f.receipt.observed.files.pop(); f.receipt.observed.files.pop(); }],
    ['duplicate directory file', f => { f.raw.directory.files.push(f.raw.directory.files[1]); }],
    ['changed file binding', f => { f.raw.directory.file_bindings[1].file_id = 'foreign-file'; }],
  ];
  for (const [name, mutate] of mutations) {
    const f = materialSelectionFixture(); mutate(f);
    assert.equal(retainedMaterialSelection(f.pack()), null, name);
  }
  assert.equal(retainedMaterialSelection(materialSelectionFixture('s_' + hash('unrecognized snapshot')).pack()), null);
  for (const field of ['sha256', 'bytes']) {
    const input = materialSelectionFixture().pack(), receipt = JSON.parse(input.receiptBytes);
    receipt.rawEvidence[field] = field === 'sha256' ? hash('other') : receipt.rawEvidence.bytes - 1;
    input.receiptBytes = Buffer.from(JSON.stringify(receipt));
    assert.equal(retainedMaterialSelection(input), null, 'raw receipt link ' + field);
  }
});

test('prepared source matching bridges only the witnessed record and file across the two retained formulas', () => {
  const f = materialSelectionFixture(), selected = retainedMaterialSelection(f.pack());
  const binding = { owner: f.owner, scope: f.scope, snapshot_id: selectionSnapshots.record_bound, version_id: f.version };
  const sdk = { ...binding, path: f.path, ...measure(f.body), record: f.record, file_binding: f.manifest.file_bindings[1] };
  const material = { path: f.path, actual_sha256: hash(f.body), identity: f.boundIdentity, source_selection: selected };
  assert.equal(preparedSourceMatches(binding, material, sdk, sdk.bytes), true);
  assert.equal(preparedSourceMatchKind(binding, material, sdk, sdk.bytes), 'retained-record-selection-v1');
  assert.equal(preparedSourceMatches(binding, { ...material, source_selection: null }, sdk, sdk.bytes), false, 'Same bytes cannot repair a stale map without the raw witness');
  const exact = { ...material, identity: { ...material.identity, bound_versions: { v1: { snapshot_id: binding.snapshot_id, version_id: binding.version_id } } } };
  assert.equal(preparedSourceMatches(binding, exact, { ...sdk, record: undefined, file_binding: undefined }, sdk.bytes), true,
    'An already exact selection keeps the original gate; the new witness is only needed across snapshot formulas');
  assert.equal(preparedSourceMatchKind(binding, exact, sdk, sdk.bytes), 'exact', 'An unused witness cannot label the exact path as a snapshot bridge');
  for (const mutate of [
    value => { value.sdk.record = { ...value.sdk.record, description: 'Other record metadata' }; },
    value => { value.sdk.file_binding.file_id = 'other-file'; },
    value => { value.sdk.file_binding.page_id = 'other-page'; },
    value => { value.material.version = 'v2'; },
    value => { value.material.identity.bound_owner = 'shared_skill:other'; },
    value => { value.binding.version_id = value.sdk.version_id = hash('other version'); },
    value => { value.binding.owner = value.sdk.owner = 'shared_skill:other'; },
    value => { value.binding.snapshot_id = value.sdk.snapshot_id = 's_' + hash('same bytes, unknown snapshot'); },
    value => { value.sdk.snapshot_id = selectionSnapshots.legacy; },
    value => { value.material.source_selection.snapshot_id = 's_' + hash('unknown material snapshot'); },
  ]) {
    const value = structuredClone({ binding, material, sdk }); mutate(value);
    assert.equal(preparedSourceMatches(value.binding, value.material, value.sdk, sdk.bytes), false);
  }
});
