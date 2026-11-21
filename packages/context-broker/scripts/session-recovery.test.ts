import { expect, test, setSystemTime } from "bun:test";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { activeNotionSession } from "./fixtures/active-notion-session";
import { createActiveSourceRestorer } from "../src/session-recovery";
import { sourceDeliveryReceipt } from "../src/session-source-snapshot";
import { DEFAULT_RESOURCE_READ_BUDGET } from "../src/resource-read-types";

test("missing fixed snapshots leave three consecutive ordinary requests usable without changing historical pins", async () => {
  const h = await activeNotionSession();
  try {
    const graph = await h.seed();
    const history = JSON.stringify(h.branch);
    h.f.state.consume = async () => h.failed("SNAPSHOT_MISSING");
    const complete = await h.turn("Continue the task.", graph.records);
    expect(complete.error).toBeUndefined(); expect(complete.provider).toBe(true); expect(complete.calls).toHaveLength(0);
    for (const [index, text] of ["继续任务。", "请刷新到最新再继续。", "暂不用技能，回答普通问题。"].entries()) {
      const turn = await h.turn(text);
      expect(turn.input).toContainEqual({ action: "continue" });
      expect(turn.error).toBeUndefined(); expect(turn.provider).toBe(true); expect(turn.aborts).toBe(0);
      expect(JSON.stringify(turn.messages)).toContain("SNAPSHOT_MISSING");
      expect(turn.messages.filter(message => message.customType === "context-broker-recovery")).toHaveLength(1);
      expect(turn.calls).toHaveLength(index === 0 ? 1 : 0);
      expect(turn.active.sources.size).toBe(2);
    }
    expect(JSON.stringify(h.branch)).toBe(history);
  } finally { await h.close(); }
});

test("a missing shared Required withholds incomplete roots and restores an independent closure", async () => {
  const h = await activeNotionSession();
  try {
    const graph = await h.seed(["root", "second", "independent"]), history = JSON.stringify(h.branch);
    h.f.state.consume = async input => input.targets.some(target => target.includes(encodeURIComponent(h.record("required").id!)))
      ? h.failed("SNAPSHOT_MISSING") : h.ready(input);
    const turn = await h.turn("Continue whatever is available.", graph.records.filter(record => record.name === "root" || record.name === "second"));
    expect(turn.error).toBeUndefined(); expect(turn.provider).toBe(true); expect(turn.aborts).toBe(0);
    const projected = JSON.stringify(turn.messages);
    expect(projected).not.toContain(h.record("root").body!.trim());
    expect(projected).not.toContain(h.record("second").body!.trim());
    expect(projected).toContain(h.record("independent").body!.trim());
    expect(projected).toContain("mandatory instruction closure is unavailable");
    expect(turn.calls).toHaveLength(2);
    expect(turn.active.sources.size).toBe(4); expect(JSON.stringify(h.branch)).toBe(history);
  } finally { await h.close(); }
});

test("a restoration denial remains authoritative on following turns while unrelated content remains usable", async () => {
  const h = await activeNotionSession();
  try {
    const graph = await h.seed(["root", "independent"]);
    h.f.state.consume = async () => h.failed("ACCESS_DENIED");
    const first = await h.turn("Restore the task.", graph.records.filter(record => record.name !== "required"));
    const next = await h.turn("Answer another question.", graph.records);
    for (const turn of [first, next]) {
      expect(turn.error).toBeUndefined(); expect(turn.provider).toBe(true); expect(turn.aborts).toBe(0);
      const projected = JSON.stringify(turn.messages);
      expect(projected).not.toContain(h.record("root").body!.trim());
      expect(projected).not.toContain(h.record("required").body!.trim());
      expect(projected).toContain(h.record("independent").body!.trim());
    }
    expect(next.calls).toHaveLength(0);
    const list = await h.tool("notion_list").execute("denial-observed", { query: "required" }, undefined, undefined, h.ctx);
    expect(JSON.stringify(list.content)).toContain("denied");
  } finally { await h.close(); }
});

test("authorization discovered after context still blocks that unsafe payload and the next request continues safely", async () => {
  const h = await activeNotionSession();
  try {
    const graph = await h.seed(["root", "independent"]);
    const unsafe = await h.turn("Continue.", graph.records, async () => {
      h.f.state.consume = async () => h.failed("ACCESS_DENIED");
      await expect(h.tool("notion_use").execute("late-denial", { ref: h.record("required").ref, refresh: true }, undefined, undefined, h.ctx))
        .rejects.toMatchObject({ code: "ACCESS_DENIED" });
    });
    expect(unsafe.provider).toBe(false); expect(unsafe.aborted).toBe(true);
    const next = await h.turn("Continue the independent task.", graph.records);
    expect(next.error).toBeUndefined(); expect(next.provider).toBe(true); expect(next.aborts).toBe(0);
    expect(JSON.stringify(next.messages)).not.toContain(h.record("required").body!.trim());
    expect(JSON.stringify(next.messages)).toContain(h.record("independent").body!.trim());
  } finally { await h.close(); }
});

test("a changed serialized restored body still fails the final payload guard", async () => {
  const h = await activeNotionSession();
  try {
    await h.seed();
    const history = JSON.stringify(h.branch);
    const turn = await h.turn("Restore the original instructions.", [], payload => {
      for (const message of payload.messages) message.content = message.content.replace(h.record("required").body!, "Unproven replacement.");
    });
    expect(turn.provider).toBe(false); expect(turn.aborted).toBe(true);
    expect(JSON.stringify(h.branch)).toBe(history);
  } finally { await h.close(); }
});

test("a Required dropped before final system context is not accepted as a complete delivery", async () => {
  const h = await activeNotionSession();
  try {
    const graph = await h.seed(), history = JSON.stringify(h.branch);
    const turn = await h.turn("Continue.", graph.records, undefined,
      messages => messages.filter(message => message.content !== h.record("required").body));
    expect(turn.error).toMatchObject({ code: "SOURCE_CONTEXT_CLOSURE_INCOMPLETE" });
    expect(turn.provider).toBe(false); expect(turn.aborted).toBe(true);
    expect(JSON.stringify(h.branch)).toBe(history);
    const next = await h.turn("Continue normally.", graph.records);
    expect(next.provider).toBe(true); expect(next.error).toBeUndefined();
  } finally { await h.close(); }
});

test("cancelled or released fixed restoration cannot publish its late result", async () => {
  for (const action of ["cancel", "release"] as const) {
    const h = await activeNotionSession();
    try {
      const graph = await h.seed(["root", "independent"]);
      const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
      h.f.state.consume = async input => { entered.resolve(); await finish.promise; return h.ready(input); };
      const pending = h.turn("Restore.", graph.records.filter(record => record.name === "independent"));
      await entered.promise;
      if (action === "cancel") h.ctx.abort?.();
      else await h.tool("notion_ctl").execute("release-during-restore", { working_set: "release", roots: [h.record("root").preparationBinding!.ref] }, undefined, undefined, h.ctx);
      const afterAction = JSON.stringify(h.branch);
      finish.resolve();
      const late = await pending;
      expect(late.provider).toBe(false);
      expect(JSON.stringify(late.messages)).not.toContain(h.record("root").body!.trim());
      expect(JSON.stringify(h.branch)).toBe(afterAction);
      const next = await h.turn("Answer another question.", graph.records.filter(record => action === "cancel" || record.name === "independent"));
      expect(next.error).toBeUndefined(); expect(next.provider).toBe(true);
      expect(next.active.sources.size).toBe(action === "cancel" ? 3 : 1);
    } finally { await h.close(); }
  }
});

test("SDK restoration errors preserve current codes and bounded diagnostics without exposing raw responses", async () => {
  const h = await activeNotionSession();
  try {
    for (const code of ["CACHE_INVALIDATED", "STATE_BUSY", "STATE_RUNTIME_UNSUPPORTED"]) {
      const details = { phase: "cache_publication", scope: h.record("root").sourceScope, record_identity: h.record("root").id,
        generation: 7, retired_through: 7, raw_response: "PRIVATE_RESPONSE" };
      h.f.state.consume = async () => h.failed(code, h.record("root"), details);
      let error: unknown;
      try { await h.f.boundary.prepareNotionSkills([h.record("root")], h.f.source, h.f.root, { purpose: "inspect" }); }
      catch (cause) { error = cause; }
      expect(error).toMatchObject({ code, details: { phase: "cache_publication", scope: details.scope,
        record_identity: details.record_identity, generation: 7, retired_through: 7 }, cause: { code } });
      if (!error || typeof error !== "object" || !("details" in error)) throw new Error("Expected source diagnostics");
      expect(JSON.stringify(error.details)).not.toContain("PRIVATE_RESPONSE");
    }
  } finally { await h.close(); }
});

test("valid current bytes cannot masquerade as a missing fixed snapshot", async () => {
  const h = await activeNotionSession();
  try {
    await h.seed();
    const history = JSON.stringify(h.branch), current = h.record("root");
    const body = "Different current root instructions B.\n", digest = createHash("sha256").update(body).digest("hex"), snapshotId = "s_" + digest;
    current.body = body; current.snapshotId = snapshotId; current.versionId = digest;
    current.preparationBinding = { ...current.preparationBinding!, snapshot_id: snapshotId, version_id: digest,
      body_sha256: digest, ref: current.preparationBinding!.ref.replace(/snapshot=s_[a-f0-9]{64}/, "snapshot=" + snapshotId) };
    const turn = await h.turn("Continue the original task.");
    expect(turn.error).toBeUndefined(); expect(turn.provider).toBe(true);
    expect(JSON.stringify(turn.messages)).not.toContain(body.trim());
    expect(JSON.stringify(turn.messages)).toContain("SOURCE_IDENTITY_MISMATCH");
    expect(JSON.stringify(h.branch)).toBe(history);
  } finally { await h.close(); }
});

test("a transient Store failure retries after bounded backoff and restores the original closure", async () => {
  const h = await activeNotionSession();
  try {
    const graph = await h.seed(), before = Date.now();
    h.f.state.consume = async () => h.failed("STATE_BUSY");
    const failed = await h.turn("Continue.");
    expect(failed.provider).toBe(true); expect(failed.error).toBeUndefined(); expect(failed.calls).toHaveLength(1);
    h.f.state.consume = async input => h.ready(input);
    const held = await h.turn("Another ordinary question.");
    expect(held.provider).toBe(true); expect(held.calls).toHaveLength(0);
    setSystemTime(before + 31_000);
    const restored = await h.turn("Continue when available.");
    expect(restored.provider).toBe(true); expect(restored.error).toBeUndefined(); expect(restored.calls).toHaveLength(1);
    for (const record of graph.records) expect(JSON.stringify(restored.messages)).toContain(record.body!.trim());
    expect(restored.messages.some(message => message.customType === "context-broker-recovery")).toBe(false);
  } finally { setSystemTime(); await h.close(); }
});

test("one recovery deadline bounds all components and a suspended late producer cannot block or publish", async () => {
  const h = await activeNotionSession(), deadline = new AbortController(), parent = new AbortController();
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let pending: ReturnType<ReturnType<typeof createActiveSourceRestorer>> | undefined;
  try {
    const graph = await h.seed(["root", "independent"]), local = h.seedLocal(), history = JSON.stringify(h.branch);
    const attempts: string[][] = [], budgets: number[] = [];
    const restore = createActiveSourceRestorer({
      assertAvailable() {}, timeout(ms) { budgets.push(ms); return deadline.signal; },
      load: async (_sources, missing, _ctx, signal) => {
        attempts.push(missing.map(source => source.record.name)); entered.resolve();
        // Deliberately ignore cancellation until released: the caller still has
        // a bounded wait and must reject these late bytes.
        await finish.promise;
        expect(signal.aborted).toBe(true);
        return graph.records.filter(record => missing.some(source => source.record.id === record.id));
      },
      render: records => {
        if (!records.length) return undefined;
        const content = records.map(record => record.body!).join("\n\n");
        return { customType: "context-broker", content, display: false,
          details: { records: records.map(record => sourceDeliveryReceipt(record, content)) } };
      },
    });
    pending = restore(h.delivered([local]), h.ctx, parent.signal, []);
    await entered.promise; deadline.abort();
    const result = await Promise.race([pending, setImmediate().then(() => undefined)]);
    expect(result).toBeDefined();
    expect(parent.signal.aborted).toBe(false); expect(attempts).toHaveLength(1);
    expect(budgets).toEqual([DEFAULT_RESOURCE_READ_BUDGET.timeBudgetMs]);
    expect(JSON.stringify(result)).toContain("SOURCE_RECOVERY_TIME_BUDGET");
    expect(JSON.stringify(result)).toContain(local.body!.trim());
    expect(result?.restored).toHaveLength(0);
    expect(JSON.stringify(h.branch)).toBe(history);
    finish.resolve(); await setImmediate();
    expect(attempts).toHaveLength(1); expect(result?.restored).toHaveLength(0);
  } finally { finish.resolve(); await pending?.catch(() => undefined); await h.close(); }
});

test("known business Disabled permits complete fixed restoration while current use remains disabled", async () => {
  const h = await activeNotionSession();
  try {
    const graph = await h.seed();
    h.f.state.consume = async input => input.purpose === "use" ? h.failed("CONTENT_DISABLED") : h.ready(input);
    await expect(h.tool("notion_use").execute("disable-current", { ref: h.record("required").ref, refresh: true }, undefined, undefined, h.ctx))
      .rejects.toMatchObject({ code: "CONTENT_DISABLED" });
    const restored = await h.turn("Continue the same task after compact.");
    expect(restored.error).toBeUndefined(); expect(restored.provider).toBe(true); expect(restored.aborts).toBe(0);
    for (const record of graph.records) expect(JSON.stringify(restored.messages)).toContain(record.body!.trim());
    expect(restored.active.sources.size).toBe(2);
  } finally { await h.close(); }
});
