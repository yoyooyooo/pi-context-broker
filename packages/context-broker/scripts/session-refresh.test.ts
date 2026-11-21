import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { activeSelection, activeSources, confirmActiveSources, missingActiveSources, SESSION_ACTIVE_ENTRY } from "../src/session-active";
import { applySelectionGraphs, persistSessionSelection, sessionSelection, type SessionSelection } from "../src/session-graph";
import { decodePreparationLock, type PreparedHostGraph } from "../src/prepare-protocol";
import { projectSelectedSourceMessages, sourceDeliveryReceipt } from "../src/session-source-snapshot";
import { releaseWorkingSetRoots } from "../src/session-working-set";
import type { AgentMessage, ContentRecord, ExtensionAPI, ExtensionContext, SessionEntry, SkillRecord } from "../src/types";

const scope = "e".repeat(64);
const id = (name: string) => "shared_skill:refresh:" + name;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";

function graph(roots: string[], edges: Array<[string, string]> = [], revisions: Record<string, string> = {}, pages: Record<string, string> = {}): PreparedHostGraph {
  const names = [...new Set([...roots, ...edges.flat()])].sort();
  const records = names.map((name): SkillRecord => {
    const metadata: ContentRecord = { id: id(name), kind: "skill", name, alias: name, description: name, enabled: true, default_context: false,
      entrypoint: "SKILL.md", ref: "skill://" + encodeURIComponent(id(name)) + "/SKILL.md",
      locator: { type: "shared_skill", library_id: "refresh", skill_id: name,
        page_id: pages[name] ?? "00000000-0000-4000-8000-000000000001",
        database_id: "00000000-0000-4000-8000-000000000002", data_source_id: "00000000-0000-4000-8000-000000000003" } };
    const body = `Complete ${name} instructions ${revisions[name] ?? "1"}.\n`, snapshotId = "s_" + hash(name + (revisions[name] ?? "1"));
    return { ...metadata, body, source: "notion", sourceId: "refresh", sourceScope: scope,
      snapshotId, versionId: hash(body), path: "/immutable/" + name + "/SKILL.md", aliases: [], normalizedAliases: [], normalizedName: name,
      normalizedDescription: name, autoloadEnabled: false,
      preparationBinding: { record: metadata, scope, snapshot_id: snapshotId, version_id: hash(body), body_sha256: hash(body), ref: metadata.ref + "?snapshot=" + snapshotId } };
  });
  const required = edges.map(([from, to]) => ({ from: id(from), to: id(to), ref: records.find(record => record.id === id(to))!.preparationBinding!.ref }));
  const vector = { version: 1 as const, kind: "observed_version_vector" as const, purpose: "use" as const, scope,
    roots: roots.map(id).sort(), required, bindings: records.map(record => record.preparationBinding!) };
  const bytes = records.reduce((total, record) => total + Buffer.byteLength(record.body!), 0);
  return { purpose: "use", scope, sourceId: "refresh", roots: vector.roots, records, bindings: vector.bindings,
    lock: decodePreparationLock({ ...vector, sha256: hash(canonical(vector)) }),
    budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
    usage: { prepared_nodes: records.length, instruction_bytes: bytes, context_bytes: bytes, max_depth: edges.length } };
}
function fixture() {
  const branch: SessionEntry[] = [];
  const ctx: ExtensionContext = { sessionManager: { getBranch: () => branch } };
  const api: ExtensionAPI = { on() {}, appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); } };
  return { branch, ctx, api };
}
const delivered = (records: readonly SkillRecord[]): AgentMessage[] => records.map(record => ({ role: "custom", customType: "context-broker", content: record.body,
  details: { records: [sourceDeliveryReceipt(record, record.body!)] } }));
function shape(selection: SessionSelection) {
  const selected = selection.scopes.get(scope);
  return { roots: [...(selected?.roots ?? [])].sort(), nodes: [...(selected?.bindings.values() ?? [])].map(binding => binding.record.id).sort() };
}
function activate(f: ReturnType<typeof fixture>, value: PreparedHostGraph) {
  persistSessionSelection(f.api, f.ctx, [value], "extend");
  confirmActiveSources(f.api, f.ctx, value.records, delivered(value.records));
}

test("refresh replaces only the requested root and preserves unrelated roots through pending, confirmation and resume", () => {
  const f = fixture(), initial = graph(["a", "c"], [["a", "b"], ["c", "d"]]);
  activate(f, initial);
  const oldLock = JSON.stringify(initial.lock), refreshed = graph(["a"], [["a", "b"]], { a: "2" });
  const pending = [{ graphs: [refreshed], mode: "replace" as const }];
  const before = JSON.stringify(f.branch);
  expect(shape(activeSelection(f.ctx, pending))).toEqual({ roots: [id("a"), id("c")], nodes: ["a", "b", "c", "d"].map(id) });
  expect(JSON.stringify(f.branch)).toBe(before);
  const projected = projectSelectedSourceMessages([...delivered(initial.records), ...delivered(refreshed.records)], activeSelection(f.ctx, pending));
  expect(JSON.stringify(projected)).toContain("Complete c instructions 1.");
  expect(JSON.stringify(projected)).not.toContain("Complete a instructions 1.");
  persistSessionSelection(f.api, f.ctx, [refreshed], "replace");
  expect(shape(sessionSelection(f.ctx))).toEqual(shape(activeSelection(f.ctx, pending)));
  expect(activeSources(f.ctx).selection.scopes.get(scope)!.bindings.get(id("a"))!.snapshot_id).toBe(initial.records.find(record => record.id === id("a"))!.snapshotId!);
  confirmActiveSources(f.api, f.ctx, refreshed.records, projected);
  expect(shape(activeSources(f.ctx).selection)).toEqual(shape(sessionSelection(f.ctx)));
  expect(missingActiveSources(f.ctx, []).map(source => source.record.name).sort()).toEqual(["a", "b", "c", "d"]);
  const resumed: ExtensionContext = { sessionManager: { getBranch: () => structuredClone(f.branch) } };
  expect(shape(activeSources(resumed).selection)).toEqual(shape(sessionSelection(f.ctx)));
  expect(JSON.stringify(initial.lock)).toBe(oldLock);
});

test("same-body refresh replaces Requires and projects retained roots from an original multi-root lock", () => {
  const f = fixture(), initial = graph(["a", "c"], [["a", "b"], ["c", "d"]]);
  activate(f, initial);
  const original = JSON.stringify(f.branch), refreshed = graph(["a"]);
  persistSessionSelection(f.api, f.ctx, [refreshed], "replace");
  const selected = sessionSelection(f.ctx).scopes.get(scope)!;
  expect(shape(sessionSelection(f.ctx))).toEqual({ roots: [id("a"), id("c")], nodes: [id("a"), id("c"), id("d")] });
  const retained = selected.graphs.find(lock => lock.roots.includes(id("c")))!;
  expect(retained.roots).toEqual([id("c")]);
  expect(retained.required).toEqual([initial.lock.required[1]!]);
  expect(retained.bindings.map(binding => binding.record.id)).toEqual([id("c"), id("d")]);
  expect(retained.sha256).not.toBe(initial.lock.sha256);
  expect(decodePreparationLock(retained)).toEqual(retained);
  confirmActiveSources(f.api, f.ctx, refreshed.records, delivered(refreshed.records));
  expect(shape(activeSources(f.ctx).selection)).toEqual(shape(sessionSelection(f.ctx)));
  expect([...activeSources(f.ctx).sources.values()].map(source => source.record.name).sort()).toEqual(["a", "c", "d"]);
  const count = f.branch.filter(entry => entry.customType === SESSION_ACTIVE_ENTRY).length;
  expect(count).toBe(2);
  confirmActiveSources(f.api, f.ctx, refreshed.records, delivered(refreshed.records));
  expect(f.branch.filter(entry => entry.customType === SESSION_ACTIVE_ENTRY)).toHaveLength(count);
  const retainedRecords = initial.records.filter(record => record.name === "c" || record.name === "d");
  confirmActiveSources(f.api, f.ctx, retainedRecords, delivered(retainedRecords));
  expect(shape(activeSources(f.ctx).selection)).toEqual(shape(sessionSelection(f.ctx)));
  expect(JSON.stringify(f.branch.slice(0, 2))).toBe(original);
});

test("a partial refresh cannot replace a shared dependency still selected by another root", () => {
  const f = fixture(), initial = graph(["a", "c"], [["a", "b"], ["c", "b"]]);
  activate(f, initial);
  const next = graph(["a"], [["a", "b"]], { a: "2", b: "2" }), before = JSON.stringify(f.branch);
  const selected = sessionSelection(f.ctx), originalScope = selected.scopes.get(scope)!;
  const originalBindings = [...originalScope.bindings], originalRoots = [...originalScope.roots], originalGraphs = [...originalScope.graphs];
  expect(() => applySelectionGraphs(selected, { graphs: [next.lock], mode: "replace", selectionId: "refresh-conflict" }))
    .toThrow(expect.objectContaining({ code: "SOURCE_SESSION_CONFLICT", details: {
      scope, id: id("b"), reason: "binding", roots: [{ scope, id: id("a") }, { scope, id: id("c") }], next: "refresh_related_roots_or_release",
    } }));
  expect([...originalScope.bindings]).toEqual(originalBindings);
  expect([...originalScope.roots]).toEqual(originalRoots);
  expect(originalScope.graphs).toEqual(originalGraphs);
  expect(() => activeSelection(f.ctx, [{ graphs: [next], mode: "replace" }])).toThrow(expect.objectContaining({ code: "SOURCE_SESSION_CONFLICT" }));
  expect(() => persistSessionSelection(f.api, f.ctx, [next], "replace")).toThrow(expect.objectContaining({ code: "SOURCE_SESSION_CONFLICT" }));
  expect(JSON.stringify(f.branch)).toBe(before);
  expect(shape(activeSources(f.ctx).selection)).toEqual(shape(sessionSelection(f.ctx)));
});

test("a partial refresh retains an unchanged shared binding and every owning root", () => {
  const f = fixture(), initial = graph(["a", "c"], [["a", "b"], ["c", "b"]]);
  activate(f, initial);
  const next = graph(["a"], [["a", "b"]], { a: "2" });
  persistSessionSelection(f.api, f.ctx, [next], "replace");
  confirmActiveSources(f.api, f.ctx, next.records, delivered(next.records));
  const active = activeSources(f.ctx);
  expect(shape(active.selection)).toEqual({ roots: [id("a"), id("c")], nodes: [id("a"), id("b"), id("c")] });
  expect(active.sources.size).toBe(3);
  expect(active.selection.scopes.get(scope)!.bindings.get(id("b"))).toEqual(initial.bindings.find(binding => binding.record.id === id("b"))!);
  expect(active.selection.scopes.get(scope)!.bindings.get(id("a"))!.snapshot_id).toBe(next.bindings.find(binding => binding.record.id === id("a"))!.snapshot_id);
});

test("same bytes from a different fixed owner cannot confirm a newly selected binding", () => {
  const f = fixture(), initial = graph(["a"]);
  activate(f, initial);
  const next = graph(["a"], [], {}, { a: "00000000-0000-4000-8000-000000000009" });
  persistSessionSelection(f.api, f.ctx, [next], "replace");
  confirmActiveSources(f.api, f.ctx, initial.records, delivered(initial.records));
  expect(f.branch.filter(entry => entry.customType === SESSION_ACTIVE_ENTRY)).toHaveLength(1);
  expect(activeSources(f.ctx).selection.scopes.get(scope)!.bindings.get(id("a"))).toEqual(initial.bindings[0]!);
  confirmActiveSources(f.api, f.ctx, next.records, delivered(next.records));
  expect(f.branch.filter(entry => entry.customType === SESSION_ACTIVE_ENTRY)).toHaveLength(2);
  expect(activeSources(f.ctx).sources.values().next().value!.record.preparationBinding).toEqual(next.bindings[0]!);
  expect(activeSources(f.ctx).selection.scopes.get(scope)!.bindings.get(id("a"))).toEqual(next.bindings[0]!);
});

test("shared Requires conflicts even when the shared node keeps the same bytes and fixed binding", () => {
  const f = fixture(), initial = graph(["a", "c"], [["a", "b"], ["c", "b"], ["b", "d"]]);
  activate(f, initial);
  const next = graph(["a"], [["a", "b"], ["b", "e"]], { a: "2" }), before = JSON.stringify(f.branch);
  expect(next.bindings.find(binding => binding.record.id === id("b"))).toEqual(initial.bindings.find(binding => binding.record.id === id("b")));
  expect(() => activeSelection(f.ctx, [{ graphs: [next], mode: "replace" }])).toThrow(expect.objectContaining({ code: "SOURCE_SESSION_CONFLICT" }));
  expect(() => persistSessionSelection(f.api, f.ctx, [next], "replace")).toThrow(expect.objectContaining({ code: "SOURCE_SESSION_CONFLICT" }));
  expect(JSON.stringify(f.branch)).toBe(before);
});

test("shared fixed bindings cannot silently change their physical owner", () => {
  const f = fixture(), initial = graph(["a", "c"], [["a", "b"], ["c", "b"]]);
  activate(f, initial);
  const next = graph(["a"], [["a", "b"]], { a: "2" }, { b: "00000000-0000-4000-8000-000000000009" });
  expect(() => persistSessionSelection(f.api, f.ctx, [next], "replace")).toThrow(expect.objectContaining({ code: "SOURCE_SESSION_CONFLICT" }));
});

test("refreshing every affected root together adopts exactly one shared dependency version", () => {
  const f = fixture(), initial = graph(["a", "c"], [["a", "b"], ["c", "b"]]);
  activate(f, initial);
  const next = [graph(["a"], [["a", "b"]], { a: "2", b: "2" }), graph(["c"], [["c", "b"]], { b: "2" })];
  expect(shape(activeSelection(f.ctx, [{ graphs: next, mode: "replace" }]))).toEqual({ roots: [id("a"), id("c")], nodes: [id("a"), id("b"), id("c")] });
  persistSessionSelection(f.api, f.ctx, next, "replace");
  const records = next.flatMap(value => value.records);
  confirmActiveSources(f.api, f.ctx, records, delivered(records));
  const active = activeSources(f.ctx);
  expect(shape(active.selection)).toEqual(shape(sessionSelection(f.ctx)));
  expect(active.sources.size).toBe(3);
  expect(active.selection.scopes.get(scope)!.bindings.get(id("b"))!.snapshot_id).toBe(next[0]!.bindings.find(binding => binding.record.id === id("b"))!.snapshot_id);
});

test("release projects a multi-root lock before the released identity can be selected again", () => {
  const f = fixture(), initial = graph(["a", "c"], [["a", "b"], ["c", "d"]]);
  activate(f, initial);
  const original = JSON.stringify(initial.lock);
  releaseWorkingSetRoots(f.api, f.ctx, [initial.records.find(record => record.id === id("a"))!.preparationBinding!.ref]);
  const selection = sessionSelection(f.ctx);
  expect(selection.scopes.get(scope)!.graphs.flatMap(lock => lock.roots)).toEqual([id("c")]);
  expect(selection.scopes.get(scope)!.graphs.flatMap(lock => lock.bindings.map(binding => binding.record.id))).toEqual([id("c"), id("d")]);
  const next = graph(["a"], [["a", "e"]], { a: "2" });
  persistSessionSelection(f.api, f.ctx, [next], "extend");
  confirmActiveSources(f.api, f.ctx, next.records, delivered(next.records));
  expect(shape(activeSources(f.ctx).selection)).toEqual({ roots: [id("a"), id("c")], nodes: [id("a"), id("c"), id("d"), id("e")] });
  expect(JSON.stringify(initial.lock)).toBe(original);
});
