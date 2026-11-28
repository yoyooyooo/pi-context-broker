import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const catalogIdentity = selection => 'catalog-' + selection;

export function cacheUpgradeState(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0x4e544e43);
    return {
      catalogs: db.prepare('SELECT scope,selection,generation,payload FROM catalogs ORDER BY scope,selection').all()
        .map(row => ({ ...row, payload_sha256: hash(row.payload) })),
      fences: db.prepare("SELECT scope,identity,generation,retired_through FROM cache_fences WHERE identity LIKE 'catalog-%' ORDER BY scope,identity").all().map(row => ({ ...row })),
      identities: db.prepare('SELECT id,scope FROM identities ORDER BY id').all().map(row => ({ ...row })),
      snapshots: db.prepare('SELECT count(*) AS count FROM snapshots').get().count,
    };
  } finally { db.close(); }
}

/** The only write hook: add metadata-only legacy rows to this new scenario's
 * consumer Store after its actual readonly discovery. No body or session is copied. */
export function seedCacheUpgrade({ path, library, base }) {
  const before = cacheUpgradeState(path);
  assert.equal(before.snapshots, 0, 'Discovery must not preload original bodies');
  const scopes = [...new Set(before.identities.map(row => row.scope))];
  assert.equal(scopes.length, 1);
  const scope = scopes[0], foreignScope = 'f'.repeat(64);
  assert.notEqual(scope, foreignScope);
  const targets = before.catalogs.filter(row => {
    const value = JSON.parse(row.payload);
    return row.scope === scope && value.library_id === library && value.coverage?.exhaustive === true
      && value.databases.some(database => database.shared_library?.version === 2 && database.shared_library.library_id === library);
  });
  assert.equal(targets.length, 1, 'Require one real current-schema catalog from SDK discovery');
  const target = targets[0], current = JSON.parse(target.payload);
  const targetDatabase = current.databases.find(row => row.shared_library?.library_id === library).database_id;
  const targetFence = before.fences.find(row => row.scope === scope && row.identity === catalogIdentity(target.selection));
  assert.ok(targetFence); assert.equal(targetFence.generation, target.generation);
  assert.ok(target.generation > targetFence.retired_through);
  const legacy = structuredClone(current);
  delete legacy.library_id; delete legacy.rejected_records; delete legacy.denied_sources;
  legacy.records = [];
  legacy.coverage = { ...current.coverage, method: 'explicit_database', exhaustive: true };
  for (const database of legacy.databases) if (database.shared_library) {
    const shared = database.shared_library;
    database.shared_library = { ...shared, version: 1, library_id: shared.operation_id, parent_page_id: shared.library_id };
  }
  const otherLibrary = '00000000-0000-4000-8000-000000009991';
  const otherDatabase = '00000000-0000-4000-8000-000000009992';
  assert.notEqual(otherDatabase, targetDatabase); assert.notEqual(otherLibrary, library);
  const unrelated = structuredClone(current);
  unrelated.library_id = otherLibrary; unrelated.records = []; unrelated.rejected_records = [];
  unrelated.databases = [structuredClone(current.databases[0])];
  unrelated.databases[0].database_id = otherDatabase;
  unrelated.databases[0].shared_library.library_id = otherLibrary;
  unrelated.databases[0].shared_library.skills.database_id = otherDatabase;
  const descriptions = [
    { role: 'legacy-complete', scope, selection: '0'.repeat(63) + '1', generation: 11, value: structuredClone(legacy) },
    { role: 'legacy-incomplete', scope, selection: '0'.repeat(63) + '2', generation: 12,
      value: { ...structuredClone(legacy), coverage: { ...current.coverage, method: 'search_and_registered', exhaustive: false, search_index_limited: true } } },
    { role: 'unrelated-current', scope, selection: 'f'.repeat(63) + '1', generation: 13, value: unrelated },
    { role: 'foreign-legacy', scope: foreignScope, selection: '0'.repeat(63) + '3', generation: 14, value: { ...structuredClone(legacy), scope: foreignScope } },
  ];
  for (const row of descriptions) {
    row.value.scope = row.scope; row.value.generation = row.generation;
    if (row.role.startsWith('legacy-')) assert.ok(row.selection < target.selection, 'Old keys must precede the current selection');
    assert.equal(before.catalogs.some(existing => existing.scope === row.scope && existing.selection === row.selection), false);
    assert.equal(before.fences.some(existing => existing.scope === row.scope && existing.identity === catalogIdentity(row.selection)), false);
  }
  const directory = join(base, 'cache-upgrade'); mkdirSync(directory, { mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const row of descriptions) {
      const payload = JSON.stringify(row.value);
      db.prepare('INSERT INTO catalogs(scope,selection,generation,payload) VALUES(?,?,?,?)').run(row.scope, row.selection, row.generation, payload);
      db.prepare('INSERT INTO cache_fences(scope,identity,generation,retired_through) VALUES(?,?,?,0)').run(row.scope, catalogIdentity(row.selection), row.generation);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
  const after = cacheUpgradeState(path);
  assert.equal(after.snapshots, 0); assert.deepEqual(after.identities, before.identities);
  const seed = { version: 1, path, directory, library, scope, target_database: targetDatabase,
    seeded_by_pid: process.pid, seeded_monotonic_ns: process.hrtime.bigint().toString(),
    target: { scope: target.scope, selection: target.selection, generation: target.generation },
    inserted: descriptions.map(({ role, scope, selection, generation }) => ({ role, scope, selection, generation })),
    before, after, copied_consumer_state: false, copied_bodies: false };
  write(join(directory, 'seed.json'), seed);
  // Publish observation configuration only after the seed transaction commits.
  write(join(base, 'cache-upgrade-config.json'), { path, directory, seed: join(directory, 'seed.json') });
  return seed;
}

let sequence = 0;
/** Called synchronously by the passive preload: actual close precedes SDK
 * finalization, and the materialization result precedes Broker onReceipt. */
export function observeCacheUpgrade(configPath, kind, event) {
  if (!configPath || !existsSync(configPath)) return;
  const accepted = kind === 'manager_transport' && event.event === 'close'
    || kind === 'context-broker.notion-materialization' && event.event === 'result'
    || kind === 'context-broker.notion-sdk-result' && event.operation === 'list';
  if (!accepted) return;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const file = String(process.pid) + '-' + String(++sequence).padStart(3, '0') + '.json';
  const snapshot = { version: 1, observer_pid: process.pid, observer_monotonic_ns: process.hrtime.bigint().toString(),
    kind, event, state: cacheUpgradeState(config.path) };
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n');
  writeFileSync(join(config.directory, file), bytes, { flag: 'wx', mode: 0o600 });
  appendFileSync(join(config.directory, 'snapshots.jsonl'), JSON.stringify({ file, bytes: bytes.length, sha256: hash(bytes) }) + '\n', { mode: 0o600 });
}

export function readCacheUpgradeEvidence(base) {
  const directory = join(base, 'cache-upgrade');
  const seed = JSON.parse(readFileSync(join(directory, 'seed.json'), 'utf8'));
  const index = readFileSync(join(directory, 'snapshots.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(new Set(index.map(row => row.file)).size, index.length);
  const snapshots = index.map(row => {
    assert.match(row.file, /^\d+-\d+\.json$/);
    const bytes = readFileSync(join(directory, row.file));
    assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256);
    return JSON.parse(bytes);
  });
  return { seed, snapshots };
}

export function assertCacheUpgradeEvidence({ seed, snapshots, events, source, piPid }) {
  const sameCatalog = (state, reference) => state.catalogs.find(row => row.scope === reference.scope && row.selection === reference.selection);
  const sameFence = (state, reference) => state.fences.find(row => row.scope === reference.scope && row.identity === catalogIdentity(reference.selection));
  assert.equal(seed.version, 1); assert.equal(seed.copied_consumer_state, false); assert.equal(seed.copied_bodies, false);
  assert.equal(seed.before.snapshots, 0); assert.equal(seed.after.snapshots, 0);
  assert.equal(seed.inserted.length, 4);
  assert.deepEqual(seed.inserted.map(row => row.role), ['legacy-complete', 'legacy-incomplete', 'unrelated-current', 'foreign-legacy']);
  const legacy = seed.inserted.filter(row => row.role.startsWith('legacy-'));
  const canaries = seed.inserted.filter(row => !row.role.startsWith('legacy-'));
  for (const state of [seed.before, seed.after, ...snapshots.map(row => row.state)]) {
    for (const row of state.catalogs) assert.equal(row.payload_sha256, hash(row.payload), 'Catalog payload bytes changed');
  }
  assert.equal(seed.inserted[2].scope, seed.scope); assert.notEqual(seed.inserted[3].scope, seed.scope);
  const unrelated = JSON.parse(sameCatalog(seed.after, seed.inserted[2]).payload);
  assert.equal(unrelated.coverage.exhaustive, true);
  assert.ok(unrelated.databases.every(row => row.database_id !== seed.target_database && row.shared_library?.version === 2));
  const priorTarget = sameCatalog(seed.before, seed.target);
  assert.ok(priorTarget); assert.deepEqual(sameCatalog(seed.after, seed.target), priorTarget);
  for (const row of legacy) {
    assert.equal(row.scope, seed.scope); assert.ok(row.selection < seed.target.selection);
    const catalog = sameCatalog(seed.after, row); assert.ok(catalog);
    const payload = JSON.parse(catalog.payload); assert.equal(payload.scope, seed.scope);
    assert.ok(payload.databases.some(database => database.database_id === seed.target_database && database.shared_library?.version === 1));
    assert.equal(sameFence(seed.after, row).retired_through, 0);
  }
  assert.equal(events.filter(row => row.kind === 'cache_upgrade_observer_error').length, 0, 'Cache observation failed');
  const observed = snapshots.filter(row => row.observer_pid === piPid);
  for (const snapshot of observed) {
    const matches = events.filter(row => row.kind === snapshot.kind && row.observer_pid === piPid
      && row.observer_monotonic_ns === snapshot.event.observer_monotonic_ns);
    assert.equal(matches.length, 1, 'A cache snapshot must bind one original diagnostic event');
    assert.deepEqual(snapshot.event, matches[0]);
    assert.ok(BigInt(snapshot.observer_monotonic_ns) >= BigInt(snapshot.event.observer_monotonic_ns));
    assert.ok(BigInt(snapshot.observer_monotonic_ns) >= BigInt(seed.seeded_monotonic_ns));
  }
  const closes = observed.filter(row => row.kind === 'manager_transport' && row.event.event === 'close');
  const results = observed.filter(row => row.kind === 'context-broker.notion-materialization' && row.event.event === 'result');
  assert.equal(closes.length, 1); assert.equal(results.length, 1);
  const close = closes[0], result = results[0];
  assert.equal(close.event.code, 0); assert.equal(close.event.signal, null);
  assert.ok(['ready', 'already_ready'].includes(result.event.status)); assert.equal(result.event.phase, 'management');
  assert.ok(BigInt(close.observer_monotonic_ns) < BigInt(result.observer_monotonic_ns));
  for (const row of [...legacy, seed.target]) {
    assert.deepEqual(sameCatalog(close.state, row), sameCatalog(seed.after, row), 'Seed must remain visible at actual manager close');
    assert.equal(sameCatalog(result.state, row), undefined, 'Management finalization must retire affected catalogs before publishing its result');
    const fence = sameFence(result.state, row); assert.ok(fence);
    assert.ok(fence.retired_through >= row.generation);
  }
  for (const snapshot of observed) for (const row of canaries) {
    assert.deepEqual(sameCatalog(snapshot.state, row), sameCatalog(seed.after, row), 'Unrelated/foreign catalog bytes changed');
    assert.deepEqual(sameFence(snapshot.state, row), sameFence(seed.after, row), 'Unrelated/foreign fence changed');
  }
  const lists = observed.filter(row => row.kind === 'context-broker.notion-sdk-result' && row.event.operation === 'list'
    && BigInt(row.observer_monotonic_ns) > BigInt(result.observer_monotonic_ns));
  assert.ok(lists.length > 0, 'A complete actual SDK catalog refresh must follow retirement');
  const rebuilt = lists.find(row => {
    const catalog = sameCatalog(row.state, seed.target);
    return catalog && catalog.generation > seed.target.generation && JSON.parse(catalog.payload).coverage?.exhaustive === true;
  });
  assert.ok(rebuilt, 'The retired current selection was not rebuilt completely at a new generation');
  const catalog = JSON.parse(sameCatalog(rebuilt.state, seed.target).payload);
  assert.equal(catalog.scope, seed.scope); assert.equal(catalog.library_id, seed.library);
  assert.ok(catalog.databases.every(row => !row.shared_library || row.shared_library.version === 2));
  const returned = rebuilt.event.value?.catalog;
  assert.equal(returned?.ok, true); assert.equal(returned.value.scope, seed.scope);
  assert.equal(returned.value.library_id, seed.library); assert.equal(returned.value.coverage.exhaustive, true);
  assert.deepEqual(returned.value.coverage.failed_sources, []);
  assert.ok(source.some(row => row.phase === 'materialize' && row.method === 'GET' && row.status === 200
    && row.terminal === 'finished' && row.request_bytes_complete === true && row.response_bytes_complete === true
    && row.semantic_write !== true && BigInt(row.started_monotonic_ns) > BigInt(result.observer_monotonic_ns)
    && BigInt(row.ended_monotonic_ns) <= BigInt(rebuilt.event.observer_monotonic_ns)), 'No actual complete catalog readback HTTP after retirement');
  const consumes = events.filter(row => row.kind === 'context-broker.notion-sdk-result' && row.operation === 'consume'
    && row.observer_pid === piPid && row.value?.status === 'ready');
  assert.ok(consumes.length > 0);
  assert.ok(consumes.every(row => BigInt(row.observer_monotonic_ns) > BigInt(rebuilt.observer_monotonic_ns)), 'Consumption overtook the complete catalog barrier');
  return { version: 1, consumer_scope: seed.scope, manager_pid: close.event.child_pid, legacy_catalogs_retired: legacy.length,
    canaries_preserved: canaries.length, prior_generation: seed.target.generation,
    refreshed_generation: sameCatalog(rebuilt.state, seed.target).generation,
    catalog_result_id: rebuilt.event.id, complete_catalog_before_consume: true };
}
