import { expect, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { activeNotionSession } from "./fixtures/active-notion-session";
import { sourceMessageText } from "../src/session-source-snapshot";
import type { SkillRecord } from "../src/types";

type Session = Awaited<ReturnType<typeof activeNotionSession>>;
function addShopping(h: Session) {
  const id = "shared_skill:current-source:shopping";
  const record = { ...h.f.record, id, name: "shopping", alias: "shopping", description: "Shopping draft",
    ref: "skill://" + encodeURIComponent(id) + "/SKILL.md", enabled: true, default_context: false,
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
    expect(calls[0]?.options).toMatchObject({ database: h.f.source.database, refresh: true, directory: {} });
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
      "--entry", h.f.source.database!, "--skill-id", "shopping"].map(quote).join(" ") };
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
    expect(h.f.calls.every(call => call.operation === "list")).toBe(true);
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
    expect(h.f.calls.every(call => call.operation === "list")).toBe(true);
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
    expect(fixed).toBe(root.preparationBinding!.ref); expect(fixed).toContain("&file_id=main-root");
    h.revise("root", "Current canonical-root comparison B.\n");
    for (const forged of [fixed.replace("file_id=main-root", "file_id=other"), fixed.replace("/SKILL.md?", "/references/guide.md?")]) {
      const count = h.f.calls.filter(call => call.operation === "consume").length;
      await expect(h.read(forged, true)).rejects.toThrow("PREPARE_ROOT_NOT_MAIN");
      await expect(h.tool("notion_use").execute("forged", { ref: forged, refresh: true }, undefined, undefined, h.ctx)).rejects.toThrow("PREPARE_ROOT_NOT_MAIN");
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
    const before = h.selected(), active = h.active(), calls = h.f.calls.length, entries = h.branch.length;
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
    expect(h.f.calls.length).toBe(calls);
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
      ref: "skill://shared_skill%3Acurrent-source%3Aabsent/SKILL.md",
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
