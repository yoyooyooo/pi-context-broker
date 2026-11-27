import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { seedCacheUpgrade, cacheUpgradeState, observeCacheUpgrade, readCacheUpgradeEvidence, assertCacheUpgradeEvidence } from './notion-sdk-pi-cache-upgrade.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function store() {
  const base = mkdtempSync(join(tmpdir(), 'source-cache-upgrade-')), path = join(base, 'state.sqlite');
  const scope = 'a'.repeat(64), library = '00000000-0000-4000-8000-000000000002', selection = '8'.repeat(64);
  const current = { scope, library_id: library, fetched_at: '2026-11-27T00:00:00.000Z', generation: 1, records: [], rejected_records: [], denied_sources: [],
    coverage: { method: 'explicit_library', exhaustive: true, failed_sources: [] },
    databases: [{ alias: 'library', database_id: '00000000-0000-4000-8000-000000000003',
      shared_library: { version: 2, library_id: library, operation_id: 'library-current',
        skills: { database_id: '00000000-0000-4000-8000-000000000003' } } }] };
  const db = new DatabaseSync(path);
  db.exec('PRAGMA application_id=1314147907;\n'
    + 'CREATE TABLE catalogs(scope TEXT,selection TEXT,generation INTEGER,payload TEXT,PRIMARY KEY(scope,selection));\n'
    + 'CREATE TABLE cache_fences(scope TEXT,identity TEXT,generation INTEGER,retired_through INTEGER,PRIMARY KEY(scope,identity));\n'
    + 'CREATE TABLE identities(id TEXT PRIMARY KEY,scope TEXT);\n'
    + 'CREATE TABLE snapshots(id TEXT PRIMARY KEY);');
  db.prepare('INSERT INTO identities VALUES(?,?)').run('auth', scope);
  db.prepare('INSERT INTO catalogs VALUES(?,?,?,?)').run(scope, selection, 1, JSON.stringify(current));
  db.prepare('INSERT INTO cache_fences VALUES(?,?,?,?)').run(scope, 'catalog-' + selection, 1, 0);
  db.close();
  return { base, path, scope, library, selection, current };
}
function evidence() {
  const f = store(), seed = seedCacheUpgrade(f), piPid = 700;
  seed.seeded_monotonic_ns = '50';
  const afterRetire = structuredClone(seed.after);
  const affected = [...seed.inserted.filter(row => row.role.startsWith('legacy-')), seed.target];
  for (const row of affected) {
    afterRetire.catalogs = afterRetire.catalogs.filter(item => item.scope !== row.scope || item.selection !== row.selection);
    afterRetire.fences.find(item => item.scope === row.scope && item.identity === 'catalog-' + row.selection).retired_through = row.generation;
  }
  const rebuilt = structuredClone(afterRetire), payload = JSON.stringify({ ...f.current, generation: 2 });
  rebuilt.catalogs.push({ scope: f.scope, selection: f.selection, generation: 2, payload, payload_sha256: hash(payload) });
  rebuilt.fences.find(row => row.scope === f.scope && row.identity === 'catalog-' + f.selection).generation = 2;
  const snapshot = (kind, event, time, state) => ({ observer_pid: piPid, observer_monotonic_ns: String(time), kind,
    event: { ...event, kind, observer_pid: piPid, observer_monotonic_ns: String(time - 1) }, state });
  const snapshots = [
    snapshot('manager_transport', { event: 'close', child_pid: 800, code: 0, signal: null }, 100, structuredClone(seed.after)),
    snapshot('context-broker.notion-materialization', { event: 'result', status: 'ready', phase: 'management' }, 200, afterRetire),
    snapshot('context-broker.notion-sdk-result', { operation: 'list', id: 'complete-list', value: { catalog: { ok: true, value: f.current } } }, 300, rebuilt),
  ];
  return { seed, piPid, snapshots, events: [...snapshots.map(row => row.event), { kind: 'context-broker.notion-sdk-result', operation: 'consume', observer_pid: piPid, observer_monotonic_ns: '400', value: { status: 'ready' } }],
  source: [{ phase: 'materialize', method: 'GET', status: 200, terminal: 'finished', request_bytes_complete: true, response_bytes_complete: true,
    started_monotonic_ns: '220', ended_monotonic_ns: '280' }] };
}

test('metadata seed keeps the real current row, no body, two earlier legacy rows and independent canaries', () => {
  const f = store(), seed = seedCacheUpgrade(f);
  assert.equal(seed.before.catalogs.length, 1); assert.equal(seed.after.catalogs.length, 5);
  assert.equal(seed.after.snapshots, 0);
  assert.deepEqual(seed.after.catalogs.find(row => row.selection === f.selection), seed.before.catalogs[0]);
  assert.equal(seed.inserted.filter(row => row.role.startsWith('legacy-')).length, 2);
  assert.throws(() => seedCacheUpgrade(f));
  assert.deepEqual(cacheUpgradeState(f.path), seed.after);
});

test('passive snapshots retain complete original state bytes and independently reject tampering', () => {
  const f = store(); seedCacheUpgrade(f);
  observeCacheUpgrade(join(f.base, 'cache-upgrade-config.json'), 'manager_transport', { event: 'close', child_pid: 9, code: 0, signal: null });
  const original = readCacheUpgradeEvidence(f.base);
  assert.equal(original.snapshots.length, 1);
  assert.deepEqual(original.snapshots[0].state, original.seed.after);
  const index = JSON.parse(readFileSync(join(f.base, 'cache-upgrade/snapshots.jsonl'), 'utf8').trim());
  writeFileSync(join(f.base, 'cache-upgrade', index.file), '{}\n');
  assert.throws(() => readCacheUpgradeEvidence(f.base));
});

test('upgrade evidence requires retirement followed by a complete new catalog before consume', () => {
  assert.equal(assertCacheUpgradeEvidence(evidence()).legacy_catalogs_retired, 2);
});
const mutations = [
  ['missing old row at actual manager close', value => { value.snapshots[0].state.catalogs = []; }],
  ['legacy row not retired', value => { value.snapshots[1].state.catalogs.push(value.seed.after.catalogs.find(row => row.selection === value.seed.inserted[0].selection)); }],
  ['target catalog not retired', value => { value.snapshots[1].state.catalogs.push(value.seed.before.catalogs[0]); }],
  ['old fence not retired', value => { value.snapshots[1].state.fences.find(row => row.identity === 'catalog-' + value.seed.inserted[0].selection).retired_through = 0; }],
  ['foreign catalog modified', value => { value.snapshots[1].state.catalogs.find(row => row.scope === 'f'.repeat(64)).payload += ' '; }],
  ['unrelated same-scope fence modified', value => { value.snapshots[1].state.fences.find(row => row.identity === 'catalog-' + value.seed.inserted[2].selection).retired_through = 13; }],
  ['missing complete refresh', value => { value.snapshots.pop(); }],
  ['refresh before finalization', value => { value.snapshots[2].observer_monotonic_ns = '150'; }],
  ['consume before complete catalog', value => { value.events.at(-1).observer_monotonic_ns = '250'; }],
  ['nonzero actual manager exit', value => { value.snapshots[0].event.code = 1; }],
  ['signal pretending to be exit zero', value => { value.snapshots[0].event.signal = 'SIGTERM'; }],
  ['failed finalization pretending to be ready', value => { value.snapshots[1].event.status = 'failed'; }],
  ['observer error', value => { value.events.push({ kind: 'cache_upgrade_observer_error' }); }],
  ['missing actual readback HTTP', value => { value.source = []; }],
  ['snapshot detached from actual SDK events', value => { value.events.shift(); }],
  ['partial returned catalog', value => { value.snapshots[2].event.value.catalog.value.coverage.exhaustive = false; }],
  ['HTTP before retirement', value => { value.source[0].started_monotonic_ns = '150'; }],
  ['body prewarming', value => { value.seed.before.snapshots = 1; }],
];
for (const [name, mutate] of mutations) test('upgrade evidence rejects ' + name, () => {
  const value = evidence(); mutate(value); assert.throws(() => assertCacheUpgradeEvidence(value));
});
