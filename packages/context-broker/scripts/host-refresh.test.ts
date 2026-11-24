import { nativeFileRef, nativeSkillId, withNativeSnapshot } from "../src/native-reference";
import { expect, setSystemTime, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { activeNotionSession } from "./fixtures/active-notion-session";
import { sourceMessageText } from "../src/session-source-snapshot";
import { noConsumptionWrites } from "../src/consumption-effects";
import { parseNativeReference } from "../src/native-reference";
import type { SkillRecord } from "../src/types";

type Session = Awaited<ReturnType<typeof activeNotionSession>>;
function addShopping(h: Session) {
  const id = "skill://shopping?library=00000000-0000-4000-8000-000000000099";
  const record = { ...h.f.record, id, name: "shopping", alias: "shopping", description: "Shopping draft",
    ref: nativeFileRef(id, "SKILL.md"), enabled: true, default_context: false,
    locator: { ...h.f.record.locator, skill_id: "shopping", page_id: "00000000-0000-4000-8000-000000000099" } };
  h.f.state.catalog = { ...h.f.state.catalog, count: h.f.state.catalog.count + 1, records: [...h.f.state.catalog.records, record] };
  return record;
}
const refreshTurn = (h: Session, ref: string | string[], before: readonly SkillRecord[], prepared?: () => void, status = 200) =>
  h.turn("Continue with the explicitly refreshed instructions.", before, undefined, undefined, [], {
    beforeContext: async () => {
      const result = await h.tool("notion_use").execute("refresh-in-turn", { ref, refresh: true }, undefined, undefined, h.ctx);
      prepared?.();
      return [{ role: "toolResult", toolName: "notion_use", toolCallId: "refresh-in-turn", ...result }];
    }, status,
  });
const payloadText = (turn: Awaited<ReturnType<Session["turn"]>>) => {
  expect(turn.error).toBeUndefined(); expect(turn.provider).toBe(true);
  return turn.payload!.messages.map(message => message.content).join("\n");
};

test("production index resolves a relative read through the scoped SDK before reading the target's own selected version", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(["root", "independent"]), root = old.records.find(record => record.name === "root")!;
    const target = old.records.find(record => record.name === "independent")!, revised = h.revise("independent", "New target bytes must not replace its selected version.\n");
    const selected = h.selected(), active = h.active(), from = h.fixedRef(root), path = "../independent/SKILL.md";
    h.f.state.resolveRelative = (requested, options) => {
      expect(requested).toBe(path); expect(options.from).toBe(root.preparationBinding!.ref);
      expect(options.library).toBe(h.f.source.library);
      return { version: 1, from: options.from, ref: revised.ref, effects: noConsumptionWrites() };
    };
    const started = h.f.calls.length, read = await h.read(path, undefined, from), calls = h.f.calls.slice(started);
    expect(calls.map(call => call.operation)).toEqual(["resolve", "consume"]);
    expect(calls[1]!.input!.purpose).toBe("inspect");
    expect(calls[1]!.input!.targets.map(parseNativeReference)).toEqual([expect.objectContaining({ selector: target.id, snapshot: target.snapshotId })]);
    expect(sourceMessageText(read.content)).toStartWith(target.body!);
    expect(sourceMessageText(read.content)).not.toContain(revised.body!);
    expect(read.details).toMatchObject({ contextBrokerRead: { binding: { record: { id: target.id } }, snapshotId: target.snapshotId,
      readStatus: { purpose: "inspect", activation_effect: "unchanged", requires_acquisition: "not_performed" } } });
    expect(h.selected().scopes.get(target.sourceScope!)!.bindings).toEqual(selected.scopes.get(target.sourceScope!)!.bindings);
    expect(h.selected().scopes.get(target.sourceScope!)!.graphs.filter(graph => graph.purpose === "use"))
      .toEqual(selected.scopes.get(target.sourceScope!)!.graphs.filter(graph => graph.purpose === "use"));
    expect(h.active()).toEqual(active);
    h.f.state.resolveRelative = () => { throw Object.assign(new Error("Source revision changed"), { code: "CURRENT_SOURCE_CHANGED" }); };
    const failedAt = h.f.calls.length;
    await expect(h.read(path, undefined, from)).rejects.toMatchObject({ admission: { code: "CURRENT_SOURCE_CHANGED" } });
    expect(h.f.calls.slice(failedAt).map(call => call.operation)).toEqual(["resolve"]);
    expect(h.active()).toEqual(active);
  } finally { await h.close(); }
});

test("metadata refresh discovers a newly created Skill before TTL without replacing active pins or fixed refs", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!, ref = h.fixedRef(root);
    const selected = h.selected().scopes.get(root.sourceScope!)!.bindings;
    const active = h.active().selection.scopes.get(root.sourceScope!)!.bindings;
    const selections = h.branch.filter(entry => entry.customType === "context-broker-selected-graph").length;
    const list = async (input: Record<string, unknown>) => JSON.parse(sourceMessageText((await h.tool("notion_list")
      .execute("discovery-after-write", input, undefined, undefined, h.ctx)).content));
    const before = await list({ limit: 1 });
    addShopping(h);
    expect((await list({ query: "shopping" })).count).toBe(0);
    const start = h.f.calls.length;
    const refreshed = await list({ query: "shopping", refresh: true });
    expect(refreshed).toMatchObject({ count: 1, coverage: { exhaustive: true }, records: [{ name: "shopping", in_default_view: false }] });
    expect(refreshed.freshness.sources).toEqual([expect.objectContaining({ source: "notion",
      validated_at: h.f.state.catalog.freshness.validated_at, max_age_ms: h.f.state.catalog.freshness.max_age_ms, stale: false })]);
    const calls = h.f.calls.slice(start);
    expect(calls.map(call => call.operation)).toEqual(["list"]);
    expect(calls[0]?.options).toMatchObject({ library: h.f.source.library, refresh: true, directory: {} });
    expect(h.selected().scopes.get(root.sourceScope!)!.bindings).toEqual(selected);
    expect(h.active().selection.scopes.get(root.sourceScope!)!.bindings).toEqual(active);
    expect(h.branch.filter(entry => entry.customType === "context-broker-selected-graph")).toHaveLength(selections);
    expect(h.f.calls.slice(start).some(call => call.operation === "consume" || call.operation === "read")).toBe(false);
    await expect(list({ limit: 1, cursor: before.next_cursor })).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
    const page = await list({ limit: 1 });
    await list({ source: "notion", refresh: true });
    await expect(list({ limit: 1, cursor: page.next_cursor })).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
    const after = h.f.calls.length;
    await expect(list({ refresh: true, cursor: page.next_cursor })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(list({ source: "foreign", refresh: true })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(h.f.calls).toHaveLength(after);
    expect(sourceMessageText((await h.read(ref)).content)).toContain(root.body!);
    const continued = await h.turn("Continue the existing task after discovering the new draft.", old.records);
    const text = payloadText(continued);
    for (const record of old.records) expect(text).toContain(record.body!.trim());
    expect(text).not.toContain("Shopping draft");
  } finally { await h.close(); }
});

test("a named metadata refresh discovers a just-enabled Skill outside the View before TTL and preserves the selected closure", async () => {
  const start = Date.now(); setSystemTime(start);
  const h = await activeNotionSession({ catalogMaxAgeMs: 300_000 });
  try {
    const target = h.record("independent");
    h.f.state.catalog = { ...h.f.state.catalog, records: h.f.state.catalog.records.map(record =>
      record.id === target.id ? { ...record, enabled: false } : record) };
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!, ref = h.fixedRef(root);
    const selected = h.selected(), active = h.active();
    const entries = structuredClone(h.branch.filter(entry => entry.customType === "context-broker-selected-graph"));
    const list = async (input: Record<string, unknown>) => JSON.parse(sourceMessageText((await h.tool("notion_list")
      .execute("named-availability", input, undefined, undefined, h.ctx)).content));
    const initial = await list({ query: target.name, refresh: true });
    expect(initial).toMatchObject({ count: 0, coverage: { exhaustive: true }, failures: [] });
    setSystemTime(start + 1000);
    h.f.state.catalog = { ...h.f.state.catalog,
      records: h.f.state.catalog.records.map(record => record.id === target.id ? { ...record, enabled: true } : record),
      freshness: { ...h.f.state.catalog.freshness, validated_at: new Date().toISOString() } };
    const before = h.f.calls.length;
    const cached = await list({ query: target.name });
    expect(cached.count).toBe(0);
    expect(cached.freshness.sources[0]).toMatchObject({ validated_at: initial.freshness.sources[0].validated_at,
      age_ms: 1000, max_age_ms: 300_000, stale: false });
    expect(h.f.calls).toHaveLength(before);
    const current = await list({ query: target.name, refresh: true });
    expect(current).toMatchObject({ count: 1, coverage: { exhaustive: true }, failures: [],
      records: [{ name: target.name, source: "notion", in_default_view: false, availability: "available" }] });
    expect(current.freshness.sources[0]).toMatchObject({ validated_at: h.f.state.catalog.freshness.validated_at, age_ms: 0, stale: false });
    expect(h.f.calls.slice(before).map(call => call.operation)).toEqual(["list"]);
    expect(h.f.calls.at(-1)?.options).toMatchObject({ refresh: true, library: h.f.source.library, directory: {} });
    expect(h.selected()).toEqual(selected); expect(h.active()).toEqual(active);
    expect(h.branch.filter(entry => entry.customType === "context-broker-selected-graph")).toEqual(entries);
    expect(h.fixedRef(root)).toBe(ref);
    const continued = payloadText(await h.turn("Continue the previously selected workflow.", old.records));
    for (const record of old.records) expect(continued).toContain(record.body!.trim());
    expect(continued).not.toContain(target.body!.trim());
  } finally { setSystemTime(); await h.close(); }
});

test("a verified native create during a pending catalog read makes its first ordinary list follow the newer directory", async () => {
  const h = await activeNotionSession();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    const original = h.f.state.list.bind(h.f.state);
    let hold = true;
    h.f.state.list = async options => {
      const captured = original(options);
      if (hold) { hold = false; entered.resolve(); await release.promise; }
      return captured;
    };
    const list = async (input: Record<string, unknown>) => JSON.parse(sourceMessageText((await h.tool("notion_list")
      .execute("write-during-discovery", input, undefined, undefined, h.ctx)).content));
    const pending = list({ query: "shopping", refresh: true });
    await entered.promise;
    const shopping = addShopping(h), locator = shopping.locator;
    if (locator.type !== "shared_skill") throw new Error("Expected native Skill identity");
    const { hostCliScope }: typeof import("../src/host-command") = await import(pathToFileURL(join(h.f.root, "src/host-command.ts")).href);
    const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
    const input = { command: [...hostCliScope([h.f.source]).command, "ctl", "library", "skill", "create", "/staged/SKILL.md",
      "--library", h.f.source.library!, "--skill-id", "shopping"].map(quote).join(" ") };
    const event = { toolName: "bash", toolCallId: "native-create", input };
    await h.emit("tool_call", event);
    await h.emit("tool_result", { ...event, isError: false, content: JSON.stringify({ ok: true, contract: "current", action: "create",
      status: "created", state: "ready", skill_id: "shopping", page_id: locator.page_id, files: 1,
      operation_id: "operation-native-create", input_sha256: "c".repeat(64), library: {
        library_id: locator.library_id, database_id: locator.database_id, data_source_id: locator.data_source_id } }) });
    const ordinary = list({ query: "shopping", source: "notion" });
    release.resolve();
    for (const result of await Promise.all([pending, ordinary])) expect(result).toMatchObject({ count: 1, records: [{ name: "shopping" }] });
    expect(h.f.calls.filter(call => call.operation === "list" && call.options.refresh)).toHaveLength(2);
    expect(h.f.calls.every(call => ["library-selection", "library", "list"].includes(call.operation))).toBe(true);
  } finally { release.resolve(); await h.close(); }
});

test("failed or partial metadata refresh cannot report a fresh complete empty directory", async () => {
  const h = await activeNotionSession();
  try {
    const list = async () => JSON.parse(sourceMessageText((await h.tool("notion_list")
      .execute("failed-refresh", { query: "shopping", refresh: true }, undefined, undefined, h.ctx)).content));
    h.f.state.paired = { version: 1, catalog: { ok: false, error: { code: "ACCESS_DENIED" } },
      directory: { ok: false, error: { code: "ACCESS_DENIED" } } };
    const failed = await list();
    expect(failed).toMatchObject({ count: 0, coverage: { exhaustive: false },
      freshness: { sources: [{ source: "notion", validated_at: null, age_ms: null, stale: null }] } });
    expect(failed.failures).toContainEqual({ source: "notion", code: "ACCESS_DENIED" });
    h.f.state.paired = undefined;
    addShopping(h);
    Object.assign(h.f.state.catalog.coverage, { exhaustive: false, failed_sources: [{ id: "unavailable-source", code: "ACCESS_DENIED" }] });
    const partial = await list();
    expect(partial).toMatchObject({ count: 1, coverage: { exhaustive: false }, records: [{ name: "shopping" }] });
    expect(partial.failures).toContainEqual({ source: "notion", code: "CATALOG_INCOMPLETE" });
    expect(partial.freshness.sources[0].validated_at).toBe(h.f.state.catalog.freshness.validated_at);
    expect(h.f.calls.every(call => ["library-selection", "library", "list"].includes(call.operation))).toBe(true);
  } finally { await h.close(); }
});

test("public use and read retain the exact disabled Requires diagnosis without replacing the fixed task", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(["root", "independent"]), root = old.records.find(record => record.name === "root")!;
    const required = old.records.find(record => record.name === "required")!, ref = h.fixedRef(root);
    const page = "41f5636c-236e-81cb-b654-ecb578fa8c52";
    const diagnostic = { code: "SHARED_ROUTER_MEMBER_UNAVAILABLE", field: "Requires", reason: "disabled", page_id: page };
    h.f.state.consume = async () => h.failed(diagnostic.code, required, { ...diagnostic, token: "private-token", response_body: "private-response" });
    const before = h.selected().scopes.get(root.sourceScope!)!;
    const error = await h.tool("notion_use").execute("disabled-required", { ref, refresh: true }, undefined, undefined, h.ctx).catch(error => error);
    const use = JSON.parse(error.message);
    expect(use.diagnostic).toEqual(diagnostic);
    expect(use.error).toContain("Requires"); expect(use.error).toContain("Enabled=false");
    expect(use.error).not.toContain("source configuration"); expect(use.error).not.toContain("/context-broker refresh");
    expect(use.error).not.toContain("source notion unavailable");
    expect(error.details).toMatchObject({ field: "Requires", reason: "disabled", page_id: page });
    const read = await h.read(ref, true).catch(error => error), blocked = JSON.parse(read.message);
    expect(blocked.diagnostic).toEqual(diagnostic);
    expect(blocked.admission.code).toBe(diagnostic.code);
    for (const value of [use, blocked]) {
      expect(JSON.stringify(value)).not.toContain("private-token"); expect(JSON.stringify(value)).not.toContain("private-response");
    }
    expect(h.selected().scopes.get(root.sourceScope!)!.bindings).toEqual(before.bindings);
    expect(h.active().selection.scopes.get(root.sourceScope!)!.bindings).toEqual(before.bindings);
    const continued = await h.turn("Continue the original task without changing its version.", old.records);
    const text = payloadText(continued);
    for (const record of old.records) expect(text).toContain(record.body!.trim());
  } finally { await h.close(); }
});

test("an unavailable relation without a disabled observation stays unknown in the public diagnosis", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!;
    const page = "41f5636c-236e-81cb-b654-ecb578fa8c52";
    h.f.state.consume = async () => h.failed("SHARED_ROUTER_MEMBER_UNAVAILABLE", h.record("required"), { field: "Requires", page_id: page });
    const error = await h.tool("notion_use").execute("unavailable-required", { ref: h.fixedRef(root), refresh: true }, undefined, undefined, h.ctx).catch(error => error);
    const result = JSON.parse(error.message);
    expect(result.diagnostic).toEqual({ code: "SHARED_ROUTER_MEMBER_UNAVAILABLE", field: "Requires", page_id: page });
    expect(result.error).toContain("missing, inaccessible or outside");
    expect(result.error).not.toContain("Enabled=false");
    expect(result.error).not.toContain("ACCESS_DENIED");
  } finally { await h.close(); }
});

test("fresh native inspection accepts an issued fixed ref without replacing active pins", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!, ref = h.fixedRef(root);
    const before = h.branch.filter(entry => entry.customType === "context-broker-selected-graph").length;
    const current = h.revise("root", "Current root B for comparison only.\n");
    const start = h.f.calls.length, result = await h.read(ref, true);
    expect(sourceMessageText(result.content)).toContain(current.body!);
    expect(result.details).toMatchObject({ contextBrokerRead: { purpose: "inspect", snapshotId: current.snapshotId } });
    const calls = h.f.calls.slice(start);
    expect(calls.filter(call => call.operation === "list")).toHaveLength(1);
    expect(calls.find(call => call.operation === "list")?.options.refresh).toBe(true);
    expect(calls.find(call => call.operation === "consume")?.input).toMatchObject({ purpose: "inspect", targets: [current.ref], freshness: { policy: "refresh" } });
    expect(h.branch.filter(entry => entry.customType === "context-broker-selected-graph")).toHaveLength(before);
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(root.snapshotId);
    expect([...h.active().sources.values()].find(item => item.record.id === root.id)?.snapshotId).toBe(root.snapshotId);
    const next = await h.turn("Compare the newly inspected body with the task's fixed instructions.", old.records, undefined, undefined, [result]);
    expect(next.error).toBeUndefined(); expect(next.provider).toBe(true);
    expect(next.messages.map(message => sourceMessageText(message.content)).join("\n")).toContain(current.body!);
    expect(sourceMessageText((await h.read(ref)).content)).toContain(root.body!);
    h.f.state.consume = async () => h.failed("SNAPSHOT_MISSING");
    const degraded = await h.turn("Explain the current inspected version while the previous capability is unavailable.", [root], undefined, undefined, [result]);
    expect(degraded.error).toBeUndefined(); expect(degraded.provider).toBe(true);
    const text = degraded.messages.map(message => sourceMessageText(message.content)).join("\n");
    expect(text).toContain(current.body!); expect(text).not.toContain(root.body!);
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(root.snapshotId);
  } finally { await h.close(); }
});

test("refresh adopts only the requested root from its existing fixed ref and preserves unrelated selection", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(["root", "independent"]), root = old.records.find(record => record.name === "root")!, independent = old.records.find(record => record.name === "independent")!;
    const ref = h.fixedRef(root), current = h.revise("root", "Adopt current root B.\n");
    const result = await h.tool("notion_use").execute("refresh-root", { ref, refresh: true }, undefined, undefined, h.ctx);
    expect(JSON.parse(sourceMessageText(result.content)).records.map((record: { content: string }) => record.content)).toContain(current.body!);
    const selected = h.selected().scopes.get(root.sourceScope!)!;
    expect([...selected.roots].sort()).toEqual([root.id!, independent.id!].sort());
    expect(selected.bindings.get(root.id!)?.snapshot_id).toBe(current.snapshotId);
    expect(selected.bindings.get(independent.id!)?.snapshot_id).toBe(independent.snapshotId);
    // Preparation alone is not a successful provider delivery.
    expect([...h.active().sources.values()].find(item => item.record.id === root.id)?.snapshotId).toBe(root.snapshotId);
  } finally { await h.close(); }
});

test("shared Requires rejects a partial refresh atomically and accepts the issued roots together", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(["root", "second"]), root = old.records.find(record => record.name === "root")!, second = old.records.find(record => record.name === "second")!;
    const refs = [h.fixedRef(root), h.fixedRef(second)];
    const required = h.revise("required", "Shared Required B.\n");
    h.revise("root", "Root B.\n"); h.revise("second", "Second B.\n");
    const partial = await h.tool("notion_use").execute("partial", { ref: refs[0], refresh: true }, undefined, undefined, h.ctx)
      .then(() => undefined, error => error);
    expect(partial).toMatchObject({ code: "SOURCE_SESSION_CONFLICT", details: { reason: "binding", roots: expect.arrayContaining([
      { scope: root.sourceScope, id: root.id }, { scope: second.sourceScope, id: second.id },
    ]) } });
    expect(JSON.parse(partial.message).conflict.roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: root.id, ref: expect.stringMatching(/^sr:C/) }),
      expect.objectContaining({ id: second.id, ref: expect.stringMatching(/^sr:C/) }),
    ]));
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(root.snapshotId);
    const retained = await h.turn("Continue after the rejected partial refresh.", old.records);
    const retainedText = payloadText(retained);
    for (const record of old.records) expect(retainedText).toContain(record.body!.trim());
    expect(retainedText).not.toContain(required.body!.trim());
    const together = await refreshTurn(h, refs, old.records);
    const text = payloadText(together);
    for (const name of ["root", "second", "required"]) expect(text).toContain(h.record(name).body!.trim());
    for (const record of old.records) expect(text).not.toContain(record.body!.trim());
    const selected = h.selected().scopes.get(root.sourceScope!)!;
    expect(selected.bindings.get(required.id!)?.snapshot_id).toBe(required.snapshotId);
    expect([...selected.roots].sort()).toEqual([root.id!, second.id!].sort());
    expect(h.active().selection.scopes.get(root.sourceScope!)?.bindings).toEqual(selected.bindings);
  } finally { await h.close(); }
});

test("failed current inspection keeps old pins and an observed authorization denial still withholds content-only bytes", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!, ref = h.fixedRef(root);
    const current = h.revise("root", "Inspected current B.\n");
    const read = await h.read(ref, true);
    h.f.state.consume = async () => h.failed("AUTH_REQUIRED", current);
    await expect(h.read(ref, true)).rejects.toThrow("AUTH_REQUIRED");
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(root.snapshotId);
    const next = await h.turn("Continue safely after permission loss.", [], undefined, undefined, [read]);
    expect(next.error).toBeUndefined(); expect(next.provider).toBe(true);
    expect(next.messages.map(message => sourceMessageText(message.content)).join("\n")).not.toContain(current.body!);
    h.f.state.consume = async input => h.ready(input);
    expect(sourceMessageText((await h.read(ref, true)).content)).toContain(current.body!);
  } finally { await h.close(); }
});

test("current metadata cannot retarget an issued root to another physical owner", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!, ref = h.fixedRef(root);
    h.f.state.catalog.records = h.f.state.catalog.records.map(record => record.id === root.id
      ? { ...record, locator: { ...record.locator, page_id: "00000000-0000-4000-8000-000000009999" } } : record);
    const before = h.f.calls.filter(call => call.operation === "consume").length;
    await expect(h.read(ref, true)).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
    expect(h.f.calls.filter(call => call.operation === "consume")).toHaveLength(before);
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(root.snapshotId);
  } finally { await h.close(); }
});

test("cancelled current preparation cannot adopt a late successful result or replace the old closure", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!, ref = h.fixedRef(root);
    h.revise("root", "Late current B.\n");
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }), suspended = new Promise<void>(resolve => { release = resolve; });
    h.f.state.consume = async input => { started(); await suspended; return h.ready(input); };
    const controller = new AbortController();
    const pending = h.tool("notion_use").execute("cancel-refresh", { ref, refresh: true }, controller.signal, undefined, h.ctx);
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    const admission = await Promise.race([entered.then(() => "entered" as const), outcome]);
    expect(admission).toBe("entered");
    controller.abort(); release();
    expect(await outcome).toMatchObject({ error: { code: expect.stringMatching(/CANCELLED/) } });
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(root.snapshotId);
    expect([...h.active().sources.values()].find(item => item.record.id === root.id)?.snapshotId).toBe(root.snapshotId);
    const next = await h.turn("Continue using the previous complete instructions.", old.records);
    expect(next.error).toBeUndefined(); expect(next.provider).toBe(true);
  } finally { await h.close(); }
});


test("the canonical fixed main emitted by working_set supports inspect and adopt while rejecting forged File identities", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!;
    const shown = await h.tool("notion_ctl").execute("show", { working_set: "show" }, undefined, undefined, h.ctx);
    const fixed = JSON.parse(sourceMessageText(shown.content)).roots[0];
    expect(fixed).toBe(root.preparationBinding!.ref); expect(fixed).not.toContain("file_id=");
    h.revise("root", "Current canonical-root comparison B.\n");
    for (const [forged, code] of [[fixed + "&file_id=other", "SOURCE_REFERENCE_INVALID"], [fixed.replace("/SKILL.md?", "/references/guide.md?"), "PREPARE_ROOT_NOT_MAIN"]]) {
      const count = h.f.calls.filter(call => call.operation === "consume").length;
      await expect(h.read(forged!, true)).rejects.toThrow(code!);
      await expect(h.tool("notion_use").execute("forged", { ref: forged, refresh: true }, undefined, undefined, h.ctx)).rejects.toMatchObject({ code });
      expect(h.f.calls.filter(call => call.operation === "consume")).toHaveLength(count);
      expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(root.snapshotId);
    }
    const inspected = await h.read(fixed, true);
    expect(sourceMessageText(inspected.content)).toContain("Current canonical-root comparison B.");
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(root.snapshotId);
    const adopted = await h.tool("notion_use").execute("canonical-adopt", { ref: fixed, refresh: true }, undefined, undefined, h.ctx);
    expect(sourceMessageText(adopted.content)).toContain("Current canonical-root comparison B.");
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(h.record("root").snapshotId);
  } finally { await h.close(); }
});


for (const changeRoot of [false, true]) test(`public refresh preserves independent roots when the main body ${changeRoot ? "changes" : "is unchanged"} and Requires changes`, async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(["root", "independent"]);
    const root = old.records.find(record => record.name === "root")!, independent = old.records.find(record => record.name === "independent")!;
    const oldRequired = old.records.find(record => record.name === "required")!, ref = h.fixedRef(root);
    const required = h.revise("required", "Updated Required instructions B.\n");
    const current = changeRoot ? h.revise("root", "Updated root instructions B.\n") : h.record("root");
    if (!changeRoot) {
      expect(current.body).toBe(root.body); expect(current.snapshotId).toBe(root.snapshotId);
      expect(current.preparationBinding).toEqual(root.preparationBinding);
    }
    const roots = [root.id!, independent.id!].sort();
    const turn = await refreshTurn(h, ref, old.records, () => {
      const selected = h.selected().scopes.get(root.sourceScope!)!;
      expect([...selected.roots].sort()).toEqual(roots);
      expect(selected.bindings.get(root.id!)).toEqual(current.preparationBinding);
      expect(selected.bindings.get(required.id!)).toEqual(required.preparationBinding);
      expect(selected.bindings.get(independent.id!)).toEqual(independent.preparationBinding);
      const active = h.active().selection.scopes.get(root.sourceScope!)!;
      expect([...active.roots].sort()).toEqual(roots);
      expect(active.bindings.get(root.id!)).toEqual(root.preparationBinding);
      expect(active.bindings.get(oldRequired.id!)).toEqual(oldRequired.preparationBinding);
    });
    const text = payloadText(turn);
    for (const record of [current, required, independent]) expect(text).toContain(record.body!.trim());
    expect(text).not.toContain(oldRequired.body!.trim());
    if (changeRoot) expect(text).not.toContain(root.body!.trim());
    const selected = h.selected().scopes.get(root.sourceScope!)!;
    expect(h.active().selection.scopes.get(root.sourceScope!)?.bindings).toEqual(selected.bindings);
    expect([...h.active().selection.scopes.get(root.sourceScope!)!.roots].sort()).toEqual(roots);
    expect(h.f.calls.filter(call => call.operation === "consume").at(-1)?.input).toMatchObject({ purpose: "use", targets: [current.ref], freshness: { policy: "refresh" } });
  } finally { await h.close(); }
});

for (const age of [999, 1000]) test(`an unchanged session keeps the complete old closure at TTL age ${age}ms until public refresh`, async () => {
  const start = Date.now(); setSystemTime(start);
  const h = await activeNotionSession({ catalogMaxAgeMs: 1000 });
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!, ref = h.fixedRef(root);
    const required = h.revise("required", "TTL current Required B.\n"), current = h.revise("root", "TTL current root B.\n");
    const before = h.f.calls.length;
    setSystemTime(start + age);
    const ordinary = await h.turn("Continue the same task without updating its instructions.", old.records);
    const text = payloadText(ordinary);
    for (const record of old.records) expect(text).toContain(record.body!.trim());
    for (const record of [current, required]) expect(text).not.toContain(record.body!.trim());
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)).toEqual(root.preparationBinding);
    expect(h.active().selection.scopes.get(root.sourceScope!)?.bindings.get(root.id!)).toEqual(root.preparationBinding);
    expect(h.f.calls.slice(before).filter(call => call.operation === "consume")).toHaveLength(0);
    const adopted = await refreshTurn(h, ref, old.records);
    const freshText = payloadText(adopted);
    for (const record of [current, required]) expect(freshText).toContain(record.body!.trim());
    for (const record of old.records) expect(freshText).not.toContain(record.body!.trim());
    expect(h.active().selection.scopes.get(root.sourceScope!)?.bindings.get(root.id!)).toEqual(current.preparationBinding);
    expect(h.active().selection.scopes.get(root.sourceScope!)?.bindings.get(required.id!)).toEqual(required.preparationBinding);
    expect(h.f.calls.filter(call => call.operation === "consume").at(-1)?.input?.freshness).toEqual({ policy: "refresh" });
  } finally { setSystemTime(); await h.close(); }
});

test("a successful public refresh followed by provider rejection keeps selected pending and active old without losing independent roots", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(["root", "independent"]), root = old.records.find(record => record.name === "root")!;
    const independent = old.records.find(record => record.name === "independent")!, oldRequired = old.records.find(record => record.name === "required")!;
    const required = h.revise("required", "Rejected provider Required B.\n"), current = h.revise("root", "Rejected provider root B.\n");
    const activeCount = h.branch.filter(entry => entry.customType === "context-broker-active-sources").length;
    const rejected = await refreshTurn(h, h.fixedRef(root), old.records, undefined, 503);
    const text = payloadText(rejected);
    for (const record of [current, required, independent]) expect(text).toContain(record.body!.trim());
    for (const record of [root, oldRequired]) expect(text).not.toContain(record.body!.trim());
    const selected = h.selected().scopes.get(root.sourceScope!)!, active = h.active().selection.scopes.get(root.sourceScope!)!;
    expect([...selected.roots].sort()).toEqual([root.id!, independent.id!].sort());
    expect([...active.roots].sort()).toEqual([...selected.roots].sort());
    expect(selected.bindings.get(root.id!)).toEqual(current.preparationBinding);
    expect(selected.bindings.get(required.id!)).toEqual(required.preparationBinding);
    expect(selected.bindings.get(independent.id!)).toEqual(independent.preparationBinding);
    expect(active.bindings.get(root.id!)).toEqual(root.preparationBinding);
    expect(active.bindings.get(oldRequired.id!)).toEqual(oldRequired.preparationBinding);
    expect(active.bindings.get(independent.id!)).toEqual(independent.preparationBinding);
    expect(h.branch.filter(entry => entry.customType === "context-broker-active-sources")).toHaveLength(activeCount);
  } finally { await h.close(); }
});

test("refresh rejects promoting an existing Required-only node before acquisition and preserves the task", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!;
    const required = old.records.find(record => record.name === "required")!;
    const before = h.selected(), active = h.active(), calls = h.f.calls.filter(call => call.operation !== "library-selection").length, entries = h.branch.length;
    const result = await h.tool("notion_use").execute("refresh-original-task", {
      ref: [root.preparationBinding!.ref, required.preparationBinding!.ref], refresh: true,
    }, undefined, undefined, h.ctx).catch(error => error);
    expect(result.code ?? "accepted").toBe("ROOT_ROLE_CONFLICT");
    const failure = JSON.parse(result.message);
    expect(failure).toMatchObject({ ok: false, status: "failed", effects: { remote_writes: "none" },
      diagnostic: { code: "ROOT_ROLE_CONFLICT", next: "refresh_task_roots_or_explicit_use" } });
    expect(failure.diagnostic.required_only).toEqual([{ scope: required.sourceScope, id: required.id,
      ref: required.preparationBinding!.ref, required_by: [root.preparationBinding!.ref] }]);
    expect(failure.diagnostic.roots).toEqual([{ scope: root.sourceScope, id: root.id, ref: root.preparationBinding!.ref }]);
    expect(failure.error).toContain("Requires");
    expect(failure.error).toContain("without refresh");
    expect(h.f.calls.filter(call => call.operation !== "library-selection").length).toBe(calls);
    expect(h.branch.length).toBe(entries);
    expect(h.selected()).toEqual(before);
    expect(h.active()).toEqual(active);
    const continued = await h.turn("Continue the same task with the original complete instructions.", old.records);
    const text = payloadText(continued);
    for (const record of old.records) expect(text).toContain(record.body!.trim());
    expect(continued.aborts).toBe(0);
  } finally { await h.close(); }
});


for (const spelling of ["current", "short"] as const) test("refresh rejects a Required-only " + spelling + " ref without new acquisition", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), required = old.records.find(record => record.name === "required")!;
    const ref = spelling === "short" ? h.fixedRef(required) : required.ref!;
    const before = h.selected(), calls = h.f.calls.length, entries = h.branch.length;
    const error = await h.tool("notion_use").execute("required-only", { ref, refresh: true }, undefined, undefined, h.ctx).catch(error => error);
    expect(error.code).toBe("ROOT_ROLE_CONFLICT");
    expect(h.f.calls.length).toBe(calls);
    expect(h.branch.length).toBe(entries);
    expect(h.selected()).toEqual(before);
  } finally { await h.close(); }
});

test("refresh still accepts a first root and a new unrelated root", async () => {
  const h = await activeNotionSession();
  try {
    const root = h.record("root"), independent = h.record("independent");
    await h.tool("notion_use").execute("first-refresh", { ref: root.ref!, refresh: true }, undefined, undefined, h.ctx);
    const before = h.selected().scopes.get(root.sourceScope!)!;
    await h.tool("notion_use").execute("new-refresh", { ref: independent.ref!, refresh: true }, undefined, undefined, h.ctx);
    const after = h.selected().scopes.get(root.sourceScope!)!;
    expect([...after.roots].sort()).toEqual([root.id!, independent.id!].sort());
    expect(after.bindings.get(root.id!)).toEqual(before.bindings.get(root.id!));
    expect(after.bindings.get(h.record("required").id!)).toEqual(before.bindings.get(h.record("required").id!));
  } finally { await h.close(); }
});

test("ordinary use can independently select a Required node and later refresh its existing root role", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!;
    const required = old.records.find(record => record.name === "required")!, ref = h.fixedRef(required);
    await h.tool("notion_use").execute("select-independent-required", { ref }, undefined, undefined, h.ctx);
    const selected = h.selected().scopes.get(root.sourceScope!)!;
    expect([...selected.roots].sort()).toEqual([root.id!, required.id!].sort());
    await h.tool("notion_use").execute("refresh-independent-required", { ref, refresh: true }, undefined, undefined, h.ctx);
    const after = h.selected().scopes.get(root.sourceScope!)!;
    expect([...after.roots].sort()).toEqual([root.id!, required.id!].sort());
    expect(after.graphs.flatMap(graph => graph.required)).toContainEqual(expect.objectContaining({ from: root.id, to: required.id }));
  } finally { await h.close(); }
});

test("released closure and inspection-only state do not block a new independent refresh", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!;
    const required = old.records.find(record => record.name === "required")!;
    await h.tool("notion_ctl").execute("release-task", { working_set: "release", roots: [h.fixedRef(root)] }, undefined, undefined, h.ctx);
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.has(required.id!) ?? false).toBe(false);
    await h.read(required.ref!, true);
    expect(h.selected().scopes.get(root.sourceScope!)?.roots.has(required.id!) ?? false).toBe(false);
    await h.tool("notion_use").execute("select-after-release-inspect", { ref: required.ref!, refresh: true }, undefined, undefined, h.ctx);
    expect([...h.selected().scopes.get(required.sourceScope!)!.roots]).toEqual([required.id!]);
  } finally { await h.close(); }
});

test("an undelivered selected use graph still protects a Required-only role without claiming activation", async () => {
  const h = await activeNotionSession();
  try {
    const root = h.record("root"), required = h.record("required");
    await h.tool("notion_use").execute("select-without-provider", { ref: root.ref! }, undefined, undefined, h.ctx);
    expect(h.active().sources.size).toBe(0);
    const before = h.selected(), calls = h.f.calls.length;
    const error = await h.tool("notion_use").execute("promote-before-delivery", { ref: required.ref!, refresh: true }, undefined, undefined, h.ctx).catch(error => error);
    expect(error.code).toBe("ROOT_ROLE_CONFLICT");
    expect(h.selected()).toEqual(before);
    expect(h.f.calls.length).toBe(calls);
    expect(h.active().sources.size).toBe(0);
  } finally { await h.close(); }
});

test("the same owner ID in a different source scope cannot supply a refresh role", async () => {
  const foreign = await activeNotionSession({ sourceScope: "a".repeat(64) });
  let current: Awaited<ReturnType<typeof activeNotionSession>> | undefined;
  try {
    const old = await foreign.seed();
    current = await activeNotionSession({ sourceScope: "b".repeat(64) });
    const required = current.record("required");
    expect(required.id).toBe(foreign.record("required").id);
    expect(required.sourceScope).not.toBe(foreign.record("required").sourceScope);
    current.branch.push(...structuredClone(foreign.branch.filter(entry => entry.customType === "context-broker-selected-graph")));
    const foreignSelection = current.selected().scopes.get(old.scope);
    expect(foreignSelection?.roots.has(required.id!)).toBe(false);
    await current.tool("notion_use").execute("refresh-current-source", { ref: required.ref!, refresh: true }, undefined, undefined, current.ctx);
    expect([...current.selected().scopes.get(required.sourceScope!)!.roots]).toEqual([required.id!]);
    expect(current.selected().scopes.get(old.scope)).toEqual(foreignSelection);
  } finally { await current?.close(); await foreign.close(); }
});


test("a Required omitted from fresh metadata is rejected by role before its missing-reference lookup", async () => {
  const h = await activeNotionSession({ catalogMaxAgeMs: 0 });
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!;
    const required = old.records.find(record => record.name === "required")!;
    const records = h.f.state.catalog.records.filter(record => record.id !== required.id);
    h.f.state.catalog = { ...h.f.state.catalog, records, count: records.length };
    await h.emit("session_switch");
    const directory = await h.tool("notion_list").execute("fresh-without-required", {}, undefined, undefined, h.ctx);
    expect(sourceMessageText(directory.content)).not.toContain('"name":"required"');
    const before = h.selected(), active = h.active(), calls = h.f.calls.length;
    const error = await h.tool("notion_use").execute("refresh-after-disabled-directory", {
      ref: [root.preparationBinding!.ref, required.preparationBinding!.ref], refresh: true,
    }, undefined, undefined, h.ctx).catch(error => error);
    expect(error.code).toBe("ROOT_ROLE_CONFLICT");
    expect(error.message).not.toContain("Enabled=false");
    expect(error.message).not.toContain("ACCESS_DENIED");
    expect(h.f.calls.length).toBe(calls);
    expect(h.selected()).toEqual(before); expect(h.active()).toEqual(active);
    const missing = await h.tool("notion_use").execute("ordinary-absent-reference", {
      ref: "skill://absent/SKILL.md?library=00000000-0000-4000-8000-000000000099",
    }, undefined, undefined, h.ctx).catch(error => error);
    expect(missing.code).toBe("SOURCE_REFERENCE_MISSING");
    expect(missing.message).not.toContain("Enabled=false");
  } finally { await h.close(); }
});

test("current inspection of a Required-only node remains read-only and preserves its role", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), required = old.records.find(record => record.name === "required")!;
    const before = h.selected(), active = h.active();
    const result = await h.read(h.fixedRef(required), true);
    expect(sourceMessageText(result.content)).toContain(required.body!);
    expect(h.selected()).toEqual(before); expect(h.active()).toEqual(active);
    expect([...h.selected().scopes.get(required.sourceScope!)!.roots]).not.toContain(required.id!);
  } finally { await h.close(); }
});


async function confirmedTaskWithOmittedRequired() {
  const h = await activeNotionSession({ catalogMaxAgeMs: 0 });
  const initial = await h.turn("Apply only root; Required remains its dependency.", [], undefined, undefined, [], {
    beforeContext: async () => {
      const result = await h.tool("notion_use").execute("initial-root", { ref: h.record("root").ref! }, undefined, undefined, h.ctx);
      return [{ role: "toolResult", toolName: "notion_use", toolCallId: "initial-root", ...result }];
    }, status: 200,
  });
  expect(initial.error).toBeUndefined(); expect(initial.provider).toBe(true);
  const root = h.record("root"), required = h.record("required");
  const rootRef = h.fixedRef(root), requiredRef = h.fixedRef(required);
  expect(h.active().selection.scopes.get(root.sourceScope!)?.roots).toEqual(new Set([root.id!]));
  expect([...h.active().sources.values()].find(source => source.record.id === required.id)?.record.preparationBinding).toEqual(required.preparationBinding);
  const rows = h.f.state.catalog.records.filter(record => record.id !== required.id);
  h.f.state.catalog = { ...h.f.state.catalog, records: rows, count: rows.length };
  await h.command("context-broker").handler("refresh", h.ctx);
  const listed = await h.tool("notion_list").execute("omitted-directory", {}, undefined, undefined, h.ctx);
  expect(sourceMessageText(listed.content)).not.toContain('"name":"required"');
  return { h, root, required, rootRef, requiredRef };
}

for (const spelling of ["short", "canonical"] as const) test("confirmed " + spelling + " fixed read survives current metadata omission without creating a current candidate or task root", async () => {
  const { h, root, required, rootRef, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    const selection = h.selected(), active = h.active();
    const read = await h.read(spelling === "short" ? requiredRef : required.preparationBinding!.ref);
    expect(sourceMessageText(read.content)).toContain(required.body!);
    expect(read.details).toMatchObject({ contextBrokerRead: { purpose: "inspect", snapshotId: required.snapshotId } });
    expect(h.selected()).toEqual(selection); expect(h.active()).toEqual(active);
    const directory = await h.tool("notion_list").execute("after-fixed-inspection", {}, undefined, undefined, h.ctx);
    expect(sourceMessageText(directory.content)).not.toContain('"name":"required"');
    const start = h.f.calls.length;
    const use = await h.tool("notion_use").execute("ordinary-use-still-missing", { ref: [rootRef, requiredRef] }, undefined, undefined, h.ctx).catch(error => error);
    expect(use.code).toBe("SOURCE_REFERENCE_MISSING");
    expect(h.f.calls.slice(start).filter(call => call.operation === "consume")).toHaveLength(0);
    expect(h.selected()).toEqual(selection); expect(h.active()).toEqual(active);
    const continued = await h.turn("Continue the original complete task.", [root, required], undefined, undefined, [read], { status: 200 });
    const text = payloadText(continued);
    expect(text).toContain(root.body!.trim()); expect(text).toContain(required.body!.trim());
    expect([...h.active().selection.scopes.get(root.sourceScope!)!.roots]).toEqual([root.id!]);
  } finally { await h.close(); }
});

test("fixed read after directory omission cannot revive a publicly released closure", async () => {
  const { h, root, required, rootRef, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    await h.tool("notion_ctl").execute("release-original-root", { working_set: "release", roots: [rootRef] }, undefined, undefined, h.ctx);
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.has(required.id!) ?? false).toBe(false);
    expect([...h.active().sources.values()].some(source => source.record.id === required.id)).toBe(false);
    for (const ref of [requiredRef, required.preparationBinding!.ref]) await expect(h.read(ref)).rejects.toThrow("SOURCE_REFERENCE_MISSING");
  } finally { await h.close(); }
});

test("fixed read cannot borrow another branch's prior active or loaded records", async () => {
  const { h, required, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    h.branch.splice(0);
    h.ctx.sessionManager!.getSessionId = () => "another-session";
    h.ctx.sessionManager!.getSessionFile = () => h.f.root + "/another-session.jsonl";
    await h.emit("session_switch");
    expect(h.selected().scopes.size).toBe(0); expect(h.active().sources.size).toBe(0);
    await expect(h.read(requiredRef)).rejects.toThrow("SHORT_REF_UNKNOWN");
    await expect(h.read(required.preparationBinding!.ref)).rejects.toThrow("SOURCE_REFERENCE_MISSING");
  } finally { await h.close(); }
});

test("fixed read requires confirmed delivery as well as a selected graph", async () => {
  const h = await activeNotionSession();
  try {
    const root = h.record("root"), required = h.record("required");
    await h.tool("notion_use").execute("selected-only", { ref: root.ref! }, undefined, undefined, h.ctx);
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.has(required.id!)).toBe(true);
    expect(h.active().sources.size).toBe(0);
    const rows = h.f.state.catalog.records.filter(record => record.id !== required.id);
    h.f.state.catalog = { ...h.f.state.catalog, records: rows, count: rows.length };
    await h.command("context-broker").handler("refresh", h.ctx);
    await expect(h.read(required.preparationBinding!.ref)).rejects.toThrow("SOURCE_REFERENCE_MISSING");
  } finally { await h.close(); }
});

test("restored branch receipts cannot authorize a fixed read when its source is disabled", async () => {
  const original = await confirmedTaskWithOmittedRequired();
  let disabled: Session | undefined;
  try {
    disabled = await activeNotionSession({ sourceEnabled: false });
    disabled.branch.push(...structuredClone(original.h.branch));
    expect([...disabled.active().sources.values()].some(source => source.record.id === original.required.id)).toBe(true);
    const before = disabled.f.calls.length;
    for (const ref of [original.requiredRef, original.required.preparationBinding!.ref])
      await expect(disabled.read(ref)).rejects.toThrow("SOURCE_UNAVAILABLE");
    expect(disabled.f.calls.slice(before).filter(call => call.operation === "consume")).toHaveLength(0);
  } finally { await disabled?.close(); await original.h.close(); }
});

test("a changed authorization scope cannot reuse another scope's confirmed fixed record", async () => {
  const original = await confirmedTaskWithOmittedRequired();
  let current: Session | undefined;
  try {
    current = await activeNotionSession({ sourceScope: "b".repeat(64) });
    current.branch.push(...structuredClone(original.h.branch));
    const rows = current.f.state.catalog.records.filter(record => record.id !== original.required.id);
    current.f.state.catalog = { ...current.f.state.catalog, records: rows, count: rows.length };
    await current.command("context-broker").handler("refresh", current.ctx);
    const before = current.f.calls.length;
    await expect(current.read(original.requiredRef)).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
    expect(current.f.calls.slice(before).filter(call => call.operation === "consume")).toHaveLength(0);
  } finally { await current?.close(); await original.h.close(); }
});

for (const code of ["AUTH_REQUIRED", "ACCESS_DENIED"] as const) test(code + " blocks the historical fixed read and ordinary continuation after metadata omission", async () => {
  const { h, root, required, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    h.f.state.consume = async () => h.failed(code, code === "AUTH_REQUIRED" ? root : required);
    await expect(h.read(root.ref!, true)).rejects.toThrow(code);
    h.f.state.consume = async input => h.ready(input);
    const before = h.f.calls.length;
    await expect(h.read(requiredRef)).rejects.toThrow(code);
    expect(h.f.calls.slice(before).filter(call => call.operation === "consume")).toHaveLength(0);
    const continued = await h.turn("Continue without inaccessible content.", [root, required]);
    const text = payloadText(continued);
    expect(text).not.toContain(root.body!.trim()); expect(text).not.toContain(required.body!.trim());
  } finally { await h.close(); }
});

test("current and forged owner snapshot or File references gain no historical read proof", async () => {
  const { h, required, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    const exact = required.preparationBinding!.ref;
    const rejected = [
      required.ref!,
      exact.replace(required.snapshotId!, "s_" + "d".repeat(64)),
      exact + "&file_id=another-file",
      nativeFileRef(nativeSkillId("00000000-0000-4000-8000-000000000099", "another-owner"), required.entrypoint!, required.snapshotId),
      nativeFileRef(nativeSkillId("b73b2ea3-0253-5e81-a1e5-c0b91aa3e2e5", "required"), required.entrypoint!, required.snapshotId),
    ];
    const before = h.f.calls.filter(call => call.operation === "consume").length;
    for (const ref of rejected) {
      const error = await h.read(ref).catch(error => error);
      expect(error).toBeInstanceOf(Error);
    }
    expect(h.f.calls.filter(call => call.operation === "consume")).toHaveLength(before);
    expect(sourceMessageText((await h.read(requiredRef)).content)).toContain(required.body!);
  } finally { await h.close(); }
});

test("fixed read after metadata omission keeps SDK missing bytes failure instead of substituting current", async () => {
  const { h, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    // Resume keeps the real branch receipts but clears process-local loaded bodies.
    await h.emit("session_switch");
    h.f.state.consume = async () => h.failed("SNAPSHOT_MISSING");
    const before = h.selected();
    await expect(h.read(requiredRef)).rejects.toThrow("SNAPSHOT_MISSING");
    expect(h.selected()).toEqual(before);
  } finally { await h.close(); }
});


test("an observed business-disabled Required still permits its exact confirmed fixed read", async () => {
  const { h, root, required, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    h.f.state.consume = async () => h.failed("CONTENT_DISABLED", required);
    await expect(h.read(root.ref!, true)).rejects.toThrow("CONTENT_DISABLED");
    h.f.state.consume = async input => h.ready(input);
    const before = h.selected(), active = h.active();
    const result = await h.read(requiredRef);
    expect(sourceMessageText(result.content)).toContain(required.body!);
    expect(h.selected()).toEqual(before); expect(h.active()).toEqual(active);
    const continued = await h.turn("Use the original confirmed task without requesting latest.", [root, required]);
    const text = payloadText(continued);
    expect(text).toContain(root.body!.trim()); expect(text).toContain(required.body!.trim());
  } finally { await h.close(); }
});

test("session switch rejects a late fixed read without borrowing the previous branch's proof", async () => {
  const { h, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    await h.emit("session_switch");
    const pending = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    h.f.state.consume = async input => { entered.resolve(); await pending.promise; return h.ready(input); };
    const read = h.read(requiredRef).then(value => ({ value }), error => ({ error }));
    expect(await Promise.race([entered.promise.then(() => "entered"), read])).toBe("entered");
    h.branch.splice(0);
    h.ctx.sessionManager!.getSessionId = () => "new-session-after-start";
    h.ctx.sessionManager!.getSessionFile = () => h.f.root + "/new-session-after-start.jsonl";
    await h.emit("session_switch");
    pending.resolve();
    expect(await read).toMatchObject({ error: { message: expect.stringMatching(/CANCELLED/) } });
    expect(h.selected().scopes.size).toBe(0); expect(h.active().sources.size).toBe(0);
  } finally { await h.close(); }
});


test("a complete empty current directory does not erase confirmed fixed main identities", async () => {
  const { h, root, required, rootRef, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    h.f.state.catalog = { ...h.f.state.catalog, records: [], count: 0 };
    await h.command("context-broker").handler("refresh", h.ctx);
    const before = h.selected(), active = h.active();
    for (const [ref, record] of [[rootRef, root], [requiredRef, required]] as const)
      expect(sourceMessageText((await h.read(ref)).content)).toContain(record.body!);
    expect(h.selected()).toEqual(before); expect(h.active()).toEqual(active);
    const directory = await h.tool("notion_list").execute("still-empty", {}, undefined, undefined, h.ctx);
    expect(JSON.parse(sourceMessageText(directory.content)).records).toEqual([]);
  } finally { await h.close(); }
});


test("a fresh reference lookup cannot hide changed scope behind an unexpired earlier directory", async () => {
  const { h, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    const freshness = { policy: "max_age", validated_at: new Date().toISOString(), age_ms: 0, max_age_ms: 1_000_000, stale: false };
    h.f.state.catalog = { ...h.f.state.catalog, freshness };
    h.f.state.directory = { ...h.f.state.directory, freshness };
    await h.command("context-broker").handler("refresh", h.ctx);
    h.f.state.catalog = { ...h.f.state.catalog, scope: "b".repeat(64) };
    h.f.state.directory = { ...h.f.state.directory, scope: "b".repeat(64) };
    const before = h.f.calls.length;
    await expect(h.read(requiredRef)).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
    expect(h.f.calls.slice(before).filter(call => call.operation === "consume")).toHaveLength(0);
  } finally { await h.close(); }
});


for (const denial of ["physical", "physical-details", "stable"] as const) test("physical owner rebind preserves the exact " + denial + " denial boundary for old active content", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(["root", "independent"]), root = old.records.find(record => record.name === "root")!;
    const independent = old.records.find(record => record.name === "independent")!, ref = h.fixedRef(root);
    if (root.locator?.type !== "shared_skill") throw new Error("Expected physical shared owner");
    const id = "skill://rebound?library=00000000-0000-4000-8000-000000000099", current = { ...root.preparationBinding!.record, id, name: "rebound", alias: "rebound",
      ref: nativeFileRef(id, "SKILL.md"), locator: { ...root.locator, skill_id: "rebound" } };
    h.f.state.catalog = { ...h.f.state.catalog, records: h.f.state.catalog.records.map(record => record.id === root.id ? current : record) };
    await h.command("context-broker").handler("refresh", h.ctx);
    const target = { ...root, ...current, ref: denial === "physical" ? "https://www.notion.so/" + root.locator.page_id.replaceAll("-", "") : current.ref };
    h.f.state.consume = async () => h.failed("ACCESS_DENIED", target, denial === "physical-details" ? { page_id: root.locator!.page_id } : {});
    await expect(h.read(current.ref, true)).rejects.toThrow("ACCESS_DENIED");
    h.f.state.consume = async input => h.ready(input);
    const fixed = await h.read(ref).then(value => ({ value }), error => ({ error }));
    const continued = await h.turn("Continue the previously confirmed task without changing its selection.", old.records);
    const text = payloadText(continued);
    if (denial !== "stable") {
      expect(fixed).toMatchObject({ error: { message: expect.stringContaining("ACCESS_DENIED") } });
      expect(text).not.toContain(root.body!.trim());
    } else {
      expect(fixed).toHaveProperty("value");
      expect(text).toContain(root.body!.trim());
    }
    expect(text).toContain(independent.body!.trim());
    expect(h.selected().scopes.get(root.sourceScope!)!.bindings.get(root.id!)).toEqual(root.preparationBinding);
  } finally { await h.close(); }
});


test("a fresh lookup authentication refusal withholds loaded and restored fixed content on ordinary continuation", async () => {
  const { h, root, required, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    const freshness = { policy: "max_age", validated_at: new Date().toISOString(), age_ms: 0, max_age_ms: 1_000_000, stale: false };
    h.f.state.catalog = { ...h.f.state.catalog, freshness };
    h.f.state.directory = { ...h.f.state.directory, freshness };
    await h.command("context-broker").handler("refresh", h.ctx);
    const list = h.f.state.list;
    h.f.state.list = () => { throw Object.assign(new Error("Controlled SDK authentication refusal"), { code: "AUTH_REQUIRED" }); };
    await expect(h.read(requiredRef)).rejects.toThrow("AUTH_REQUIRED");
    h.f.state.list = list;
    const visible = await h.turn("Continue without updating the original instructions.", [root, required]);
    const missing = await h.turn("Continue while original instructions are no longer in context.");
    const texts = [payloadText(visible), payloadText(missing)];
    const evidence = process.env.CONTEXT_BROKER_FIXED_READ_EVIDENCE;
    if (evidence) await writeFile(join(evidence, "lookup-auth-continuation.json"), JSON.stringify({
      schema: 1, level: "production index/host/source adapter/provider hooks; controlled SDK authentication failure and Pi session manager",
      source: { id: root.sourceId, scope: root.sourceScope }, original: [root.preparationBinding, required.preparationBinding],
      visible: { provider: visible.provider, payload: visible.payload, restore_calls: visible.calls },
      missing: { provider: missing.provider, payload: missing.payload, restore_calls: missing.calls },
    }, null, 2) + "\n", { flag: "wx" });
    for (const text of texts) {
      expect(text).not.toContain(root.body!.trim());
      expect(text).not.toContain(required.body!.trim());
    }
  } finally { await h.close(); }
});


test("a late older lookup authentication refusal cannot replace a newer exact denial", async () => {
  const { h, root, requiredRef } = await confirmedTaskWithOmittedRequired();
  try {
    const freshness = { policy: "max_age", validated_at: new Date().toISOString(), age_ms: 0, max_age_ms: 1_000_000, stale: false };
    h.f.state.catalog = { ...h.f.state.catalog, freshness };
    h.f.state.directory = { ...h.f.state.directory, freshness };
    await h.command("context-broker").handler("refresh", h.ctx);
    const list = h.f.state.list, entered = Promise.withResolvers<void>(), pending = Promise.withResolvers<unknown>();
    let requests = 0;
    h.f.state.list = options => { if (requests++ === 0) { entered.resolve(); return pending.promise; } return list(options); };
    const older = h.read(requiredRef).then(value => ({ value }), error => ({ error }));
    expect(await Promise.race([entered.promise.then(() => "entered"), older])).toBe("entered");
    h.f.state.consume = async () => h.failed("ACCESS_DENIED", root);
    await expect(h.read(root.ref!, true)).rejects.toThrow("ACCESS_DENIED");
    pending.reject(Object.assign(new Error("Older SDK authentication refusal"), { code: "AUTH_REQUIRED" }));
    expect(await older).toMatchObject({ error: { message: expect.stringContaining("AUTH_REQUIRED") } });
    h.f.state.consume = async input => h.ready(input);
    await expect(h.read(h.fixedRef(root))).rejects.toThrow("ACCESS_DENIED");
  } finally { await h.close(); }
});
