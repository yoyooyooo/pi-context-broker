import assert from "node:assert/strict";
import { notionCatalogAction, notionListExpired, notionListFreshness } from "../src/catalog-menu";
import { createDollarSkillAutocompleteProvider } from "../src/dollar";
import type { DiscoveryRecord, NotionListObservation } from "../src/types";
import { createCompletionSnapshot, localCompletionCandidate, type CompletionCandidate } from "../src/completion-candidates";

const validated = "2026-10-19T00:00:00.000Z";
const at = Date.parse(validated);
const fresh: NotionListObservation = { sourceId: "notion", policy: "default", validatedAt: validated, ageMs: 0, maxAgeMs: 60_000, stale: false };

assert.equal(notionCatalogAction({ offline: false, sourceIds: ["notion"], observations: [fresh], failedSourceIds: [], now: at + 1_000, retryAt: at + 5_000 }), "use");
assert.equal(notionListExpired(fresh, at + 59_999), false);
assert.equal(notionListExpired(fresh, at + 60_000), true);
assert.equal(notionListExpired({ ...fresh, ageMs: 30_000 }, at + 59_999), false, "Reported age is not added to the elapsed time since validation a second time");
assert.equal(notionListExpired({ ...fresh, ageMs: 30_000 }, at + 60_000), true);
assert.equal(notionListExpired({ ...fresh, ageMs: 30_000 }, at - 1), true, "Clock rollback invalidates the observation");
assert.equal(notionListExpired({ ...fresh, stale: true }, at), true);
assert.equal(notionListExpired({ ...fresh, policy: "offline", stale: true }, at + 120_000), false);
assert.equal(notionListExpired({ sourceId: "notion", policy: "pinned" }, at + 120_000), false);
assert.equal(notionListExpired(undefined, at), true);
assert.deepEqual(notionListFreshness(fresh, at + 59_999), { policy: "default", validated_at: validated, age_ms: 59_999, max_age_ms: 60_000, stale: false });
assert.deepEqual(notionListFreshness(fresh, at + 60_000), { policy: "default", validated_at: validated, age_ms: 60_000, max_age_ms: 60_000, stale: true });
assert.equal(notionListFreshness({ ...fresh, ageMs: 30_000 }, at + 1_000).age_ms, 30_000);
assert.equal(notionListFreshness({ ...fresh, policy: "offline", stale: true }, at + 120_000).stale, true);
assert.equal(notionListFreshness(fresh, at - 1).age_ms, null);
assert.equal(notionListFreshness(fresh, at - 1).stale, null, "An unknown age cannot prove fresh metadata after clock rollback");
assert.deepEqual(notionListFreshness(undefined, at), { policy: null, validated_at: null, age_ms: null, max_age_ms: null, stale: null });
assert.equal(notionCatalogAction({ offline: false, sourceIds: ["notion"], observations: [fresh], failedSourceIds: [], now: at + 1_000 }), "use");
assert.equal(notionCatalogAction({ offline: true, sourceIds: ["notion"], observations: [], failedSourceIds: ["notion"], now: at }), "use");
assert.equal(notionCatalogAction({ offline: false, sourceIds: ["notion"], observations: [fresh], failedSourceIds: [], now: at + 60_000 }), "refresh");
assert.equal(notionCatalogAction({ offline: false, sourceIds: ["notion"], observations: [], failedSourceIds: [], now: at, retryAt: at + 5_000 }), "wait");

const resin = {
  name: "Resin",
  normalizedName: "resin",
  description: "Operate the resin proxy",
  normalizedDescription: "operate the resin proxy",
  aliases: [],
  normalizedAliases: [],
  path: "/cache/resin/SKILL.md",
  kind: "skill",
  source: "notion",
  selectionToken: "resin@notion",
} as DiscoveryRecord;
const added = { ...resin, name: "Added", normalizedName: "added", selectionToken: "added@notion", path: "/cache/added/SKILL.md" } as DiscoveryRecord;

const native = {
  async getSuggestions() { return null; },
  applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
};
const listeners = new Set<() => void>();
let notifications = 0;
const snapshot = createCompletionSnapshot(() => { notifications++; for (const listener of listeners) listener(); });
const owner = {};
const resinCandidate = localCompletionCandidate(resin), addedCandidate = localCompletionCandidate(added);
snapshot.local([resinCandidate]);
const accepted: CompletionCandidate[] = [];
const provider = createDollarSkillAutocompleteProvider(native, {
  read: snapshot.read, scope: () => owner,
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
}, candidate => accepted.push(candidate));
let updates = 0;
const unsubscribe = provider.subscribe!(() => updates++);
assert.equal(provider.getCompletionScope!(), owner);
const initial = await provider.getSuggestions(["$re"], 0, 3);
assert.deepEqual(initial?.items.map(item => item.value), ["$resin@notion"]);
snapshot.accept(snapshot.begin("cache"), [addedCandidate], "Updating Notion catalog");
assert.equal(updates, 1);
assert.deepEqual((await provider.getSuggestions(["$"], 0, 1))?.items.map(item => item.value), ["$added@notion", "$resin@notion"]);
assert.ok((await provider.getSuggestions(["$"], 0, 1))?.items.every(item => item.value), "Warnings are not selectable completion rows");
const selected = provider.applyCompletion(["$re"], 0, 3, initial!.items[0]!, "$re");
assert.equal(selected.lines[0], "$resin@notion ");
assert.equal(accepted[0], resinCandidate, "Accept the exact displayed target, not a fresh lookup by token");

const cache = snapshot.begin("cache");
const freshTicket = snapshot.begin("refresh");
snapshot.accept(freshTicket, [{ ...addedCandidate, record: { ...addedCandidate.record, name: "Zulu" } }]);
assert.equal(snapshot.accept(cache, [resinCandidate]), false, "A late cache cannot overwrite a settled refresh");
assert.equal(snapshot.accept(snapshot.begin("cache"), [resinCandidate]), false, "A newly read cache cannot outrank settled refresh authority");
const oldRefresh = snapshot.begin("refresh"), newRefresh = snapshot.begin("refresh");
snapshot.accept(newRefresh, []);
assert.equal(snapshot.accept(oldRefresh, [addedCandidate]), false, "A late older refresh cannot resurrect a removed candidate");
assert.deepEqual(snapshot.read().candidates, [resinCandidate], "Complete empty removes only remote candidates; local discovery remains");
const foreign = createCompletionSnapshot(() => {});
assert.equal(snapshot.accept(foreign.begin("refresh"), [addedCandidate]), false);
const beforeRetire = notifications;
snapshot.retire();
snapshot.local([]);
assert.equal(snapshot.accept(snapshot.begin("refresh"), [addedCandidate]), false);
assert.equal(notifications, beforeRetire, "Retired scopes cannot publish");
unsubscribe();

const faulting = createDollarSkillAutocompleteProvider(native, {
  read() { throw new Error("broken publisher"); }, subscribe: () => () => {}, scope: () => owner,
});
assert.equal(await faulting.getSuggestions(["$"], 0, 1), null);
const cancelled = new AbortController();
const rejecting = createDollarSkillAutocompleteProvider({
  ...native, async getSuggestions() { throw new Error("native provider rejected"); },
}, { read: () => ({ candidates: [], revision: 0 }), subscribe: () => () => {}, scope: () => owner });
assert.equal(await rejecting.getSuggestions(["plain"], 0, 5), null);
const uncooperative = createDollarSkillAutocompleteProvider({
  ...native, getSuggestions: () => new Promise(() => {}),
}, { read: () => ({ candidates: [], revision: 0 }), subscribe: () => () => {}, scope: () => owner });
const pending = uncooperative.getSuggestions(["plain"], 0, 5, cancelled.signal);
cancelled.abort();
assert.equal(await pending, null, "Cancellation settles a producer that ignores AbortSignal");
await import("./catalog-menu-session.test");
console.log("catalog menu checks passed: memory-only filtering, snapshot notifications, exact target acceptance, stale publication fences, and failure containment");
