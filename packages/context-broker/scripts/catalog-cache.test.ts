import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { currentNotionFixture } from "./fixtures/current-notion-source";
import { noConsumptionWrites } from "../src/consumption-effects";

// Broker publishes disposable metadata stubs. Authorization, TTL and shared
// catalog caching belong to the same SDK operation on every consumption path.
const f = await currentNotionFixture();
const validatedAt = "2026-11-01T00:00:00.000Z";
f.state.catalog.freshness = { ...f.state.catalog.freshness, validated_at: validatedAt, age_ms: 60000, stale: true };
for (const source of [f.source, { ...f.source, id: "second-host", namespace: "second" }]) {
  const records = await f.boundary.discoverNotionSource(source, f.root);
  assert.equal(records[0]?.body, undefined);
  assert.equal(records.list.validatedAt, validatedAt);
  assert.equal(records.list.ageMs, 60000);
  assert.equal(records.list.stale, true);
  assert.equal(records[0]?.sourceId, source.id);
  assert.ok(!(await readFile(records[0]!.path, "utf8")).includes(f.body));
}
assert.equal(f.calls.length, 2, "Each host observation enters the authoritative SDK; Broker does not renew a separate catalog TTL");
await f.boundary.discoverNotionSource({ ...f.source, discovery: { maxAge: "1s" } }, f.root);
assert.equal(f.calls.at(-1)?.options.maxAge, 1000);
await f.boundary.discoverNotionSource(f.source, f.root, { refresh: true });
assert.equal(f.calls.at(-1)?.options.refresh, true);
await f.boundary.discoverNotionSource({ ...f.source, discovery: { offline: true } }, f.root);
assert.equal(f.calls.at(-1)?.options.offline, true);
assert.equal(await stat(join(f.source.cacheDir!, "catalogs-v4")).then(() => true, () => false), false);

const selectedSources = [f.source, { ...f.source, id: "other", namespace: "other" },
  { ...f.source, id: "offline", namespace: "offline", discovery: { offline: true } }];
f.state.directory = { ...f.state.catalog, records: [], count: 0, view: null, view_selection: "none" };
f.calls.length = 0;
await f.sources.discoverSourceCatalog({ sources: selectedSources }, f.root, {
  refreshSourceIds: [f.source.id, "offline"], directorySelections: new Map(selectedSources.map(source => [source.id, {}])),
});
assert.equal(f.calls.length, 3);
assert.equal(f.calls[0]?.options.refresh, true, "The selected configured source reaches the authoritative SDK refresh");
assert.equal(f.calls[1]?.options.refresh, undefined, "Another configured source retains its normal freshness policy");
assert.equal(f.calls[2]?.options.refresh, undefined, "Explicit metadata refresh preserves configured offline policy");
assert.equal(f.calls[2]?.options.offline, true);
assert.ok(f.calls.every(call => call.operation === "list" && call.options.directory));

// A host entry can converge locally, but its presence never short-circuits the
// selected operation's freshness or permission check.
f.calls.length = 0;
const records = await Promise.all([f.boundary.loadNotionSkill(f.selected, f.source, f.root), f.boundary.loadNotionSkill(f.selected, f.source, f.root)]);
assert.equal(records[0]?.path, records[1]?.path);
assert.equal(await readFile(records[0]!.path, "utf8"), f.body);
assert.deepEqual(f.calls.map(call => call.operation), ["consume", "consume"]);
f.state.transform = () => ({ version: 1, status: "failed", effects: noConsumptionWrites(), error: { code: "ACCESS_DENIED", message: "revoked" } });
await assert.rejects(f.boundary.loadNotionSkill(f.selected, f.source, f.root), { code: "ACCESS_DENIED" });
assert.equal(f.calls.length, 3);
console.log("SDK-owned freshness, metadata-only indexes and independent current authorization checks passed");
