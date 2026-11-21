import { expect, test } from "bun:test";
import { createConsumerObservations, currentEvidence } from "../src/consumer-observation";
import { preparationFailureDetails } from "../src/prepare-protocol";
import type { SkillRecord } from "../src/types";

const record: SkillRecord = { id: "shared_skill:library:root", source: "notion", sourceId: "notion", sourceScope: "scope-a",
  name: "root", description: "A root", enabled: true, path: "/immutable/root/SKILL.md", aliases: [],
  normalizedName: "root", normalizedDescription: "a root", normalizedAliases: [], autoloadEnabled: true };
const observed = (validatedAt: number, origin: "remote" | "cache" = "remote", enabled = true): SkillRecord => ({
  ...record, enabled, currentObservation: { origin, validatedAt, validUntil: validatedAt + 100 },
});

test("current source evidence preserves original validation time and excludes historical/offline data", () => {
  const freshness = { policy: "default", validated_at: new Date(10).toISOString(), max_age_ms: 100, stale: false };
  expect(currentEvidence(freshness, "local_cache")).toEqual({ origin: "cache", validatedAt: 10, validUntil: 110 });
  for (const policy of ["offline", "pinned"])
    expect(currentEvidence({ ...freshness, policy }, "notion")).toBeUndefined();
  expect(currentEvidence({ ...freshness, stale: true }, "local_cache")).toBeUndefined();
  expect(currentEvidence({ ...freshness, stale: true, max_age_ms: 0 }, "notion")?.validUntil).toBe(10);
  expect(currentEvidence(freshness, "local_snapshot")).toBeUndefined();
});

test("a reliable newer observation supersedes denial; fixed and older cached successes do not", () => {
  let clock = 20;
  const store = createConsumerObservations(() => 0, () => clock);
  store.deny(record, store.begin(), "CONTENT_DISABLED");
  clock = 30;
  expect(store.observe(record, store.begin())).toBe(false);
  expect(store.observe(observed(19, "cache"), store.begin())).toBe(false);
  expect(store.observe(observed(20, "cache"), store.begin())).toBe(false);
  expect(store.state(record)).toBe("disabled");
  expect(store.observe(observed(30), store.begin())).toBe(true);
  expect(store.state(record)).toBe("available");
});

test("late old failures, retired generations and cancelled operations cannot publish", () => {
  let epoch = 0, clock = 20;
  const store = createConsumerObservations(() => epoch, () => clock);
  const old = store.begin();clock = 30;
  store.observe(observed(30), store.begin());
  expect(store.deny(record, old, "CONTENT_DISABLED")).toBe(false);
  const pending = store.begin();epoch++;
  expect(store.deny(record, pending, "CONTENT_DISABLED")).toBe(false);
  const controller = new AbortController(), cancelled = store.begin(controller.signal);controller.abort();
  expect(store.deny(record, cancelled, "ACCESS_DENIED")).toBe(false);
  expect(store.state(record)).toBe("available");
});

test("a newer cache return is not a newer server observation and cannot hide an in-flight denial", () => {
  let clock = 20;
  const store = createConsumerObservations(() => 0, () => clock);
  const remote = store.begin();clock = 30;
  store.observe(observed(10, "cache"), store.begin());
  expect(store.deny(record, remote, "CONTENT_DISABLED")).toBe(true);
  expect(store.state(record)).toBe("disabled");
});

test("scope and denied-state identity stay separate from fixed content and unknown transport errors", () => {
  const store = createConsumerObservations(() => 0, () => 30);
  store.deny(record, store.begin(), "ACCESS_DENIED");
  expect(store.denial(record)).toBe("ACCESS_DENIED");
  expect(store.state({ ...record, sourceScope: "scope-b" })).toBe("available");
  expect(store.observe({ ...observed(29, "cache"), snapshotId: "fixed" }, store.begin())).toBe(false);
  expect(store.state(record)).toBe("denied");
  expect(store.observe(observed(30), store.begin())).toBe(true);
  expect(store.denial(record)).toBeUndefined();
});

test("preparation failure attribution identifies the dependency rather than its caller", () => {
  const scope = "a".repeat(64), root = "shared_skill:library:root", child = "shared_skill:library:required";
  const ref = (id: string) => "skill://" + encodeURIComponent(id) + "/SKILL.md";
  const error = { code: "CONTENT_DISABLED", details: { id: child } };
  const result = preparationFailureDetails({ preparation: { scope, nodes: [
    { state: "prepared", id: root, ref: ref(root) },
    { state: "failed", id: child, ref: ref(child), error },
  ], errors: [{ target: ref(root), ...error }] } });
  expect(result?.denials).toEqual([{ scope, id: child, ref: ref(child), code: "CONTENT_DISABLED" }]);
  expect(preparationFailureDetails({ preparation: { scope, errors: [{ target: ref(root), code: "CONTENT_DISABLED" }] } })?.denials).toBeUndefined();
  expect(preparationFailureDetails({ preparation: { scope: "foreign", nodes: [{state:"failed",id:root,ref:ref(root),error}] } })?.denials).toBeUndefined();
});
