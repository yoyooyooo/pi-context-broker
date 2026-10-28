import assert from "node:assert/strict";
import { createSourceRuntime } from "../src/source-runtime";
import { ReferenceMiss, SourceError } from "../src/notion-source";
import type { SkillRecord } from "../src/types";

const record: SkillRecord = { name: "remote", description: "metadata", aliases: [], autoloadEnabled: true, normalizedName: "remote", normalizedDescription: "metadata", normalizedAliases: [], path: "/metadata/SKILL.md", sourceId: "notion", sourceScope: "scope", id: "page", defaultDiscovery: true };
const snapshot = { ...record, body: "complete body", path: "/snapshot/SKILL.md", snapshotId: "snapshot", versionId: "version", freshness: { policy: "max_age", validated_at: "2026-01-01T00:00:00.000Z", age_ms: 0, max_age_ms: 1, stale: false } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

// Two foreground consumers and a background owner share one real download.
let calls = 0;
let providerSignal: AbortSignal | undefined;
let finish = Promise.withResolvers<SkillRecord>();
const runtime = createSourceRuntime(async (_record, signal) => { calls++; providerSignal = signal; return finish.promise; });
runtime.prepare([record]);
const first = new AbortController();
const cancelled = runtime.load(record, first.signal);
const surviving = runtime.load(record);
first.abort();
await assert.rejects(cancelled, { code: "SOURCE_CANCELLED" });
await tick();
assert.equal(calls, 1);
assert.equal(providerSignal?.aborted, false);
finish.resolve(snapshot);
assert.deepEqual(await surviving, snapshot);
assert.equal(runtime.diagnostics()[0]?.state, "ready");
assert.equal("body" in runtime.diagnostics()[0]!, false);
await tick();
finish = Promise.withResolvers<SkillRecord>();
const validateAgain = runtime.load(record);
await tick();
assert.equal(calls, 2, "Ready bytes cannot silently extend CLI validation TTL");
finish.resolve(snapshot);
await validateAgain;

// A cancelled foreground consumer cannot cancel another foreground consumer.
const isolatedFinish = Promise.withResolvers<SkillRecord>();
let sharedSignal: AbortSignal | undefined;
const isolated = createSourceRuntime(async (_record, signal) => { sharedSignal = signal; return isolatedFinish.promise; });
const cancelOne = new AbortController();
const one = isolated.load(record, cancelOne.signal);
const two = isolated.load(record);
await tick();
cancelOne.abort();
await assert.rejects(one, { code: "SOURCE_CANCELLED" });
assert.equal(sharedSignal?.aborted, false);
isolatedFinish.resolve(snapshot);
await two;

// A verified source write retires shared reads only for future submissions.
const writeReleases: Array<PromiseWithResolvers<SkillRecord>> = [];
const writeSignals: AbortSignal[] = [];
const writes = createSourceRuntime(async (_record, signal) => {
  writeSignals.push(signal);
  const release = Promise.withResolvers<SkillRecord>();
  writeReleases.push(release);
  return release.promise;
}, 3);
const draftB = writes.load(record);
const otherSource = writes.load({ ...record, sourceId: "other" });
await tick();
writes.forgetSources(["notion"]);
assert.equal(writeSignals[0]!.aborted, false, "A source write does not cancel the accepted next draft's read");
assert.equal(writeSignals[1]!.aborted, false, "An unrelated source keeps its running request");
const laterSelection = writes.load(record);
const joinedOther = writes.load({ ...record, sourceId: "other" });
await tick();
assert.equal(writeReleases.length, 3, "Only the changed source starts a new read");
writeReleases[0]!.resolve(snapshot);
writeReleases[1]!.resolve(snapshot);
writeReleases[2]!.resolve({ ...snapshot, body: "new body", snapshotId: "new-snapshot" });
assert.equal((await draftB).snapshotId, "snapshot", "An already-owned preparation keeps its selected snapshot");
assert.equal((await laterSelection).snapshotId, "new-snapshot");
await Promise.all([otherSource, joinedOther]);
const closing = writes.load(record);
await tick();
writes.forgetSources(["notion"]);
writes.dispose();
await assert.rejects(closing, { code: "SOURCE_CANCELLED" });
assert.equal(writeSignals[3]!.aborted, true, "Shutdown still cancels retired reads owned by a pending preparation");
writeReleases[3]!.resolve(snapshot);

// Cancellation before provider dispatch, refresh and shutdown all fence late results.
let dispatched = 0;
const stopped = createSourceRuntime(async () => { dispatched++; return snapshot; });
stopped.prepare([record]);
stopped.dispose();
await tick();
assert.equal(dispatched, 0);
assert.equal(stopped.diagnostics()[0]?.state, "cancelled");
await assert.rejects(stopped.load(record), { code: "SOURCE_CANCELLED" });
const late = Promise.withResolvers<SkillRecord>();
const refreshed = createSourceRuntime(async () => late.promise);
refreshed.prepare([record]);
await tick();
refreshed.invalidate();
late.resolve(snapshot);
await tick();
assert.equal(refreshed.diagnostics()[0]?.state, "cancelled");
assert.equal(refreshed.diagnostics()[0]?.snapshotId, undefined);

// A bounded scheduler drains larger catalogs without launching unbounded work.
const releases: Array<PromiseWithResolvers<SkillRecord>> = [];
let active = 0;
let peak = 0;
let total = 0;
const bounded = createSourceRuntime(async () => {
  total++; active++; peak = Math.max(peak, active);
  const release = Promise.withResolvers<SkillRecord>();
  releases.push(release);
  try { return await release.promise; } finally { active--; }
}, 2, 3);
bounded.prepare(Array.from({ length: 12 }, (_, index) => ({ ...record, id: `page-${index}` })));
await tick();
assert.equal(peak, 2);
assert.ok(bounded.diagnostics().filter(item => item.state === "queued").length <= 3);
for (let index = 0; index < 12; index++) {
  releases[index]!.resolve(snapshot);
  await tick();
}
assert.equal(total, 12);
assert.equal(peak, 2);
bounded.dispose();

// A full background queue yields a slot to explicit selection and eventually resumes every default.
const priorityReleases: Array<PromiseWithResolvers<SkillRecord>> = [];
const order: string[] = [];
const priority = createSourceRuntime(async item => {
  order.push(item.id!);
  const release = Promise.withResolvers<SkillRecord>();
  priorityReleases.push(release);
  return release.promise;
}, 1, 2);
priority.prepare(Array.from({ length: 6 }, (_, index) => ({ ...record, id: `default-${index}` })));
await tick();
const explicit = priority.load({ ...record, id: "explicit" });
priorityReleases[0]!.resolve(snapshot);
await tick();
assert.equal(order[1], "explicit");
priorityReleases[1]!.resolve(snapshot);
await explicit;
await tick();
for (let index = 2; index < 7; index++) { priorityReleases[index]!.resolve(snapshot); await tick(); }
assert.equal(new Set(order).size, 7, "Displaced default preparation resumes without dropping an identity");
priority.dispose();
const joinedReleases: Array<PromiseWithResolvers<SkillRecord>> = [];
const joinedOrder: string[] = [];
const joined = createSourceRuntime(async item => {
  joinedOrder.push(item.id!);
  const release = Promise.withResolvers<SkillRecord>();
  joinedReleases.push(release);
  return release.promise;
}, 1, 3);
joined.prepare(Array.from({ length: 4 }, (_, index) => ({ ...record, id: `queued-${index}` })));
await tick();
const promoted = joined.load({ ...record, id: "queued-3" });
joinedReleases[0]!.resolve(snapshot);
await tick();
assert.equal(joinedOrder[1], "queued-3", "Foreground joining a queued default promotes it ahead of background work");
joinedReleases[1]!.resolve(snapshot);
await promoted;
joined.dispose();

// Failures retain safe codes and do not accidentally publish ready state.
const failed = createSourceRuntime(async () => { throw new SourceError("ACCESS_DENIED", "notion"); });
await assert.rejects(failed.load(record), { code: "ACCESS_DENIED" });
assert.equal(failed.diagnostics()[0]?.state, "error");
assert.equal(failed.diagnostics()[0]?.error, "ACCESS_DENIED");
const missing = createSourceRuntime(async () => { throw new ReferenceMiss("notion"); });
await assert.rejects(missing.load(record), error => error instanceof ReferenceMiss);
assert.equal(missing.diagnostics()[0]?.state, "missing");
assert.equal(missing.diagnostics()[0]?.error, undefined, "A selected-page miss never becomes a storage failure diagnostic");
missing.dispose();
// Prompt is explicit-only; Router preparation never expands its member list.
let kindLoads: string[] = [];
const kindRuntime = createSourceRuntime(async item => { kindLoads.push(item.kind ?? "skill"); return item; });
kindRuntime.prepare([{ ...record, kind: "prompt", id: "prompt" }, { ...record, kind: "router", id: "router", members: [{ type: "local", name: "member", path: "/member/SKILL.md" }] }]);
await tick();
assert.deepEqual(kindLoads, ["router"]);
await kindRuntime.load({ ...record, kind: "prompt", id: "prompt" });
assert.deepEqual(kindLoads, ["router", "prompt"]);
kindRuntime.dispose();
console.log("source runtime behavioral checks passed");
