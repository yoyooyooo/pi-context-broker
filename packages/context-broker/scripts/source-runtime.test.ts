import assert from "node:assert/strict";
import { createSourceRuntime } from "../src/source-runtime";
import { selectPrefetchPlans, type PrefetchBudget, type PrefetchOutcome, type PrefetchPlan } from "../src/prefetch-policy";
import { normalizeSources } from "../src/sources";
import { ReferenceMiss, SourceError } from "../src/notion-source";
import type { SkillRecord } from "../src/types";

const record: SkillRecord = { name: "remote", description: "metadata", aliases: [], autoloadEnabled: true, normalizedName: "remote", normalizedDescription: "metadata", normalizedAliases: [], path: "/metadata/SKILL.md", source: "notion", sourceId: "notion", sourceScope: "scope", id: "page", defaultDiscovery: true };
const snapshot = { ...record, body: "complete body", path: "/snapshot/SKILL.md", snapshotId: "snapshot", versionId: "version", freshness: { policy: "max_age", validated_at: "2026-01-01T00:00:00.000Z", age_ms: 0, max_age_ms: 1, stale: false } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const budget: PrefetchBudget = { maxNodes: 2, maxBytes: 65536, maxDepth: 0, maxTimeMs: 1000, rateShare: 0.1 };
const plan: PrefetchPlan = { source: { type: "notion", id: "notion", prefetch: budget }, records: [record], budget };
const outcome: PrefetchOutcome = { preparedNodes: 1, contextBytes: 2000, instructionBytes: 13,
  records: [{ id: record.id!, scope: record.sourceScope!, snapshotId: "snapshot", bodySha256: "sha", bytes: 13 }] };

// Daily/default and legacy boolean configuration never imply a body budget.
for (const prefetch of [undefined, false, true, {}, { maxNodes: 0 }]) {
  const sources = normalizeSources([{ type: "notion", id: "notion", prefetch }])!;
  assert.deepEqual(selectPrefetchPlans([record], sources), []);
}
for (const prefetch of [0, "false", null, { maxNodes: -1 }, { maxBytes: 1.5 }, { rateShare: 1.1 }, { maxTimeMs: 2 ** 32 }, { surprise: true }])
  assert.throws(() => normalizeSources([{ type: "notion", id: "notion", prefetch }]));
const sources = normalizeSources([{ type: "notion", id: "notion", prefetch: budget }])!;
const catalog = [{ ...record, kind: "router" as const, members: Array.from({ length: 56 }, (_, index) => ({ type: "local" as const, name: "member-" + index, path: "/unused" })) },
  ...Array.from({ length: 56 }, (_, index) => ({ ...record, id: "member-" + index, defaultDiscovery: false }))];
assert.deepEqual(selectPrefetchPlans(catalog, sources).map(item => item.records.map(row => row.id)), [["page"]]);
assert.deepEqual(selectPrefetchPlans([{ ...record, kind: "prompt" }], sources), []);
assert.equal(selectPrefetchPlans(Array.from({length: 20}, (_, index) => ({...record,id:"visible-"+index})), sources)[0]?.records.length, 2);

let calls = 0, warmCalls = 0;
const daily = createSourceRuntime(async () => { calls++; return snapshot; }, 2, 32, async () => { warmCalls++; return outcome; });
daily.prefetch(selectPrefetchPlans(catalog, [{ type: "notion", id: "notion" }]));
await tick();
assert.equal(calls, 0); assert.equal(warmCalls, 0);
await daily.load(record);
assert.equal(calls, 1);
assert.equal(daily.diagnostics()[0]?.loaded, false);
daily.dispose();

// Background completion publishes only safe prepared diagnostics, never body or binding.
const warmed = createSourceRuntime(async () => snapshot, 2, 32, async () => outcome);
warmed.prefetch([plan]); await tick();
assert.equal(warmed.diagnostics()[0]?.state, "prepared");
assert.equal(warmed.diagnostics()[0]?.purpose, "prefetch");
assert.equal(warmed.diagnostics()[0]?.loaded, false);
assert.equal("body" in warmed.diagnostics()[0]!, false);
assert.equal("lock" in warmed.diagnostics()[0]!, false);
warmed.dispose();

// A selected foreground graph immediately cancels speculative work and does not await it.
const warmRelease = Promise.withResolvers<PrefetchOutcome>();
let warmSignal: AbortSignal | undefined, explicitCalls = 0;
const priority = createSourceRuntime(async () => { explicitCalls++; return snapshot; }, 2, 32,
  async (_plan, signal) => { warmSignal = signal; return warmRelease.promise; });
priority.prefetch([plan]); await tick();
assert.equal(warmSignal?.aborted, false);
assert.equal(await priority.foreground(async () => "selected graph ready"), "selected graph ready");
assert.equal(warmSignal?.aborted, true);
await priority.load(record);
assert.equal(explicitCalls, 1, "Foreground selection revalidates through its ordinary source path");
warmRelease.resolve(outcome); await tick();
assert.equal(priority.diagnostics().find(row => row.purpose === "prefetch")?.state, "cancelled");
assert.equal(priority.diagnostics().find(row => row.purpose === "prefetch")?.records, undefined);
priority.dispose();

// Time and session budgets fence a callback that ignores cancellation and completes late.
for (const reason of ["time", "session"] as const) {
  const released = Promise.withResolvers<PrefetchOutcome>(), cancelled = Promise.withResolvers<void>();
  const runtime = createSourceRuntime(async () => snapshot, 2, 32, async (_plan, signal) => {
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true }); return released.promise;
  });
  runtime.prefetch([{ ...plan, budget: { ...budget, maxTimeMs: reason === "time" ? 5 : 1000 } }]);
  await tick();
  if (reason === "session") runtime.invalidate();
  await cancelled.promise;
  released.resolve(outcome); await tick();
  assert.equal(runtime.diagnostics()[0]?.state, "cancelled");
  assert.equal(runtime.diagnostics()[0]?.records, undefined);
  await runtime.load(record);
  runtime.dispose();
}

// Pressure stops queued prefetch. Permission failure stays local to its background task.
for (const code of ["RATE_LIMITED", "ACCESS_DENIED"]) {
  const warmedSources: string[] = [];
  const runtime = createSourceRuntime(async () => snapshot, 2, 32, async item => {
    warmedSources.push(item.source.id); if (item.source.id === "notion") throw new SourceError(code, "notion"); return outcome;
  });
  runtime.prefetch([plan, { ...plan, source: { ...plan.source, id: "other" }, records: [{ ...record, sourceId: "other" }] }]);
  await tick();
  assert.deepEqual(warmedSources, code === "RATE_LIMITED" ? ["notion"] : ["notion", "other"]);
  assert.equal(runtime.diagnostics()[0]?.state, code === "RATE_LIMITED" ? "deferred" : "error");
  assert.equal((await runtime.load(record)).body, snapshot.body);
  runtime.dispose();
}
const oversized = createSourceRuntime(async () => snapshot, 2, 32, async () => ({ ...outcome, contextBytes: 65537 }));
oversized.prefetch([plan]); await tick();
assert.equal(oversized.diagnostics()[0]?.error, "SOURCE_PREFETCH_BUDGET");
oversized.dispose();

// Foreground waiters share only an in-flight validated read. One cancel cannot kill another.
let loads = 0, signal: AbortSignal | undefined;
let release = Promise.withResolvers<SkillRecord>();
const shared = createSourceRuntime(async (_record, input) => { loads++; signal = input; return release.promise; });
const cancelled = new AbortController();
const one = shared.load(record, cancelled.signal), two = shared.load(record);
await tick(); cancelled.abort();
await assert.rejects(one, { code: "SOURCE_CANCELLED" });
assert.equal(loads, 1); assert.equal(signal?.aborted, false);
release.resolve(snapshot); await two; await tick();
release = Promise.withResolvers<SkillRecord>();
const revalidated = shared.load(record); await tick();
assert.equal(loads, 2, "A ready or prefetched cache is not authorization/freshness proof");
release.resolve(snapshot); await revalidated;
shared.dispose();

// A source write retires reads only for future selections; shutdown still cancels retired owners.
const releases: Array<PromiseWithResolvers<SkillRecord>> = [], signals: AbortSignal[] = [];
const writes = createSourceRuntime(async (_record, signal) => {
  signals.push(signal); const next = Promise.withResolvers<SkillRecord>(); releases.push(next); return next.promise;
}, 3);
const original = writes.load(record), unrelated = writes.load({ ...record, sourceId: "other" });
await tick(); writes.forgetSources(["notion"]);
assert.equal(signals[0]?.aborted, false); assert.equal(signals[1]?.aborted, false);
const next = writes.load(record), joinOther = writes.load({ ...record, sourceId: "other" });
await tick(); assert.equal(releases.length, 3);
releases[0]!.resolve(snapshot); releases[1]!.resolve(snapshot); releases[2]!.resolve({ ...snapshot, snapshotId: "new" });
assert.equal((await original).snapshotId, "snapshot"); assert.equal((await next).snapshotId, "new");
await Promise.all([unrelated, joinOther]);
const pending = writes.load(record); await tick(); writes.forgetSources(["notion"]); writes.dispose();
await assert.rejects(pending, { code: "SOURCE_CANCELLED" }); assert.equal(signals[3]?.aborted, true);
releases[3]!.resolve(snapshot);

// Foreground queue and concurrency stay bounded; no background work displaces selected owners.
const completed: Array<PromiseWithResolvers<SkillRecord>> = [];
let active = 0, peak = 0;
const bounded = createSourceRuntime(async () => {
  active++; peak = Math.max(peak, active);
  const item = Promise.withResolvers<SkillRecord>(); completed.push(item);
  try { return await item.promise; } finally { active--; }
}, 2, 2);
const queued = Array.from({ length: 4 }, (_, index) => bounded.load({ ...record, id: "q-" + index }));
await tick();
await assert.rejects(bounded.load({ ...record, id: "overflow" }), { code: "SOURCE_QUEUE_FULL" });
assert.equal(peak, 2);
completed[0]!.resolve(snapshot); completed[1]!.resolve(snapshot); await tick();
completed[2]!.resolve(snapshot); completed[3]!.resolve(snapshot); await Promise.all(queued);
bounded.dispose();

const missing = createSourceRuntime(async () => { throw new ReferenceMiss("notion"); });
await assert.rejects(missing.load(record), error => error instanceof ReferenceMiss);
assert.equal(missing.diagnostics()[0]?.state, "missing");
assert.equal(missing.diagnostics()[0]?.error, undefined);
missing.dispose();
console.log("source runtime foreground ownership and zero-default budget prefetch checks passed");
