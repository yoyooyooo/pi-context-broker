import { expect, setSystemTime, test } from "bun:test";
import { activeNotionSession } from "./fixtures/active-notion-session";
import { sourceMessageText } from "../src/session-source-snapshot";
import type { SkillRecord } from "../src/types";

type Session = Awaited<ReturnType<typeof activeNotionSession>>;
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
