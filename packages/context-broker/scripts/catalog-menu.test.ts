import assert from "node:assert/strict";
import { notionCatalogAction, notionListExpired } from "../src/catalog-menu";
import { createDollarSkillAutocompleteProvider } from "../src/dollar";
import type { AutocompleteSuggestions, DiscoveryRecord, NotionListObservation } from "../src/types";

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
let publish: (menu: { records: DiscoveryRecord[]; notice?: string }) => void = () => {};
const followUp = new Promise<{ records: DiscoveryRecord[]; notice?: string }>((resolve) => { publish = resolve; });
const provider = createDollarSkillAutocompleteProvider({
  async getSuggestions() { return null; },
  applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
}, async () => ({ records: [resin], notice: "Updating Notion catalog", followUp }));
const partials: AutocompleteSuggestions[] = [];
const pendingResult = provider.getSuggestions(["$re"], 0, 3, undefined, (partial) => { partials.push(partial); });
await Promise.resolve();
assert.equal(partials.length, 1);
const initial = partials[0]!;
assert.equal(initial.items[0]?.value, "$resin@notion");
const notice = initial.items.find(item => !item.value)!;
const kept = provider.applyCompletion(["$re"], 0, 3, notice, "$re");
assert.deepEqual(kept, { lines: ["$re"], cursorLine: 0, cursorCol: 3 });
const selected = provider.applyCompletion(["$re"], 0, 3, initial.items[0]!, "$re");
assert.equal(selected.lines[0], "$resin@notion ");
publish({ records: [resin, added] });
const result = await pendingResult;
assert.deepEqual(result?.items.map((item) => item.value), ["$resin@notion", "$added@notion"]);
const refreshOrder = Promise.withResolvers<{ records: DiscoveryRecord[] }>();
const orderProvider = createDollarSkillAutocompleteProvider({
  async getSuggestions() { return null; },
  applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
}, async () => ({ records: [resin, added], followUp: refreshOrder.promise }));
const orderResult = orderProvider.getSuggestions(["$"], 0, 1, undefined, () => {});
await Promise.resolve();
refreshOrder.resolve({ records: [resin, { ...added, name: "Zulu", normalizedName: "zulu" }] });
assert.deepEqual((await orderResult)?.items.map(item => item.value), ["$added@notion", "$resin@notion"], "A refreshed sort order must not move the user's current choice");
const removedChoice = Promise.withResolvers<{ records: DiscoveryRecord[] }>();
const removalProvider = createDollarSkillAutocompleteProvider({
  async getSuggestions() { return null; },
  applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
}, async () => ({ records: [resin, added], followUp: removedChoice.promise }));
const removalResult = removalProvider.getSuggestions(["$"], 0, 1, undefined, () => {});
await Promise.resolve();
removedChoice.resolve({ records: [resin] });
assert.deepEqual((await removalResult)?.items.map(item => item.value), ["", "$resin@notion"], "A removed choice cannot silently become a different selectable item");
const cancelled = new AbortController();
const waiting = Promise.withResolvers<{ records: DiscoveryRecord[] }>();
const staleProvider = createDollarSkillAutocompleteProvider({
  async getSuggestions() { return null; },
  applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
}, async () => ({ records: [], notice: "Reading Notion catalog", followUp: waiting.promise }));
const stale = staleProvider.getSuggestions(["$re"], 0, 3, cancelled.signal);
await Promise.resolve();
cancelled.abort();
assert.equal(await stale, null, "Cancelled same-draft refresh must settle without source completion");
waiting.resolve({ records: [resin] });
await import("./catalog-menu-session.test");
console.log("catalog menu checks passed: fresh list stays cached, expired and failed lists refresh, a notice cannot replace the draft, and the same menu receives the updated list");
