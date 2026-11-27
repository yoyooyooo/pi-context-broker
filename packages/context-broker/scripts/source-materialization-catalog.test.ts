import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { activeNotionSession } from "./fixtures/active-notion-session";
import { withContextPreparationDeadline, type SourcePreparationScope } from "../src/skill-preparation";
import type { SourceMaterializationRequest, SourceMaterializationReceipt, SourceMemberCandidate } from "../src/source-materialization-contract";

/** The production index and host hooks run unchanged; only SDK operations and
 * the session are controlled. Real cross-PID SQLite/HTTP stays in the Pi gate. */
async function fixture(targetNames = ["root"], setup: Parameters<typeof activeNotionSession>[0] = {}) {
  const session = await activeNotionSession({ catalogMaxAgeMs: 300_000, ...setup });
  const { f } = session, scope = f.selected.sourceScope!;
  const root = session.record("root").preparationBinding!.record;
  const required = session.record("required").preparationBinding!.record;
  const candidate: SourceMemberCandidate = { type: "source_member", library_id: f.source.library!, scope,
    source_id: "registered-origin", member_key: "skills/root", expected_skill_id: "entry", registration_digest: "a".repeat(64),
    name: root.name, alias: root.alias, description: root.description, enabled: true, readiness: "materializable", record: root };
  const members = targetNames.map(name => {
    const record = session.record(name).preparationBinding!.record;
    if (record.locator.type !== "shared_skill") throw new Error("Expected a physical Skill");
    return { ...candidate, name, alias: name, member_key: "skills/" + name, expected_skill_id: record.locator.skill_id, record };
  });
  const management = "export const SOURCE_MATERIALIZATION_VERSION=1, PACKAGE_VERSION='current-source-fixture';let handler;export function configure(value){handler=value;}export async function materializeSource(input){return handler(input);}";
  const path = join(f.root, "src/ntn-skills-management.mjs");
  await writeFile(path, management);
  const manifestPath = join(f.root, "src/ntn-skills-runtime.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, management_sha256: createHash("sha256").update(management).digest("hex") }));
  const manager: { configure(handler: (input: SourceMaterializationRequest) => Promise<SourceMaterializationReceipt>): void } = await import(pathToFileURL(path).href);
  let ready = false, persisted = true;
  const trace: string[] = [], list = f.state.list.bind(f.state), consume = f.state.consume.bind(f.state), candidates = f.state.candidates.bind(f.state);
  let refresh: () => Promise<void> = async () => {}, consumeWait = refresh;
  let managementWait: (request: SourceMaterializationRequest) => Promise<void> = async () => {};
  manager.configure(async input => {
    trace.push("management"); await managementWait(input); ready = true; persisted = false;
    const member = members.find(value => value.expected_skill_id === input.target.expected_skill_id);
    if (!member) throw new Error("Unexpected materialization target");
    return { version: 1, request_id: input.request_id, library_id: input.library, scope, target: input.target,
      ...(input.authorization_root ? { authorization_root: input.authorization_root } : {}),
      status: "ready", operation_id: "source-materialization", records: member.record.id === required.id ? [required] : [member.record, required],
      affected_skill_ids: [...new Set([member.expected_skill_id, "required"])],
      source_revisions: [{ source_id: candidate.source_id, revision: "b".repeat(64) }], effects: { remote_writes: "management", projection: "none" } };
  });
  f.state.sourceMembers = async input => ({ version: 1, library_id: f.source.library, scope, coverage: "complete", candidates: members.filter(member => member.expected_skill_id === input.query || member.name === input.query), failures: [], effects: { remote_writes: "none" } });
  f.state.candidates = options => persisted ? candidates(options) : { kind: "miss", reason: "catalog_unavailable" };
  f.state.consume = async (input, options) => {
    trace.push(ready ? "consume" : "missing-current-schema");
    if (ready) await consumeWait();
    return ready ? consume(input, options) : session.failed("CURRENT_SKILL_NOT_READY", session.record("root"));
  };
  f.state.list = async options => {
    if (ready) {
      trace.push("catalog");
      expect(options.refresh).toBe(true);
      await refresh();
      persisted = true;
    }
    return list(options);
  };
  return { session, trace, root, required, scope, candidate, setRefresh: (run: () => Promise<void>) => { refresh = run; },
    setManagement: (run: (request: SourceMaterializationRequest) => Promise<void>) => { managementWait = run; }, setConsume: (run: () => Promise<void>) => { consumeWait = run; }, persisted: () => persisted };
}

test("materialization rebuilds the real complete catalog before ordinary consumption and retains unrelated members", async () => {
  const { session, trace, persisted } = await fixture();
  try {
    const result = await session.turn("Use $root@notion");
    expect(result.error).toBeUndefined();
    expect(result.provider).toBe(true);
    expect(trace.slice(0, 4)).toEqual(["missing-current-schema", "management", "catalog", "consume"]);
    expect(trace.filter(value => value === "catalog")).toHaveLength(1);
    expect(persisted()).toBe(true);
    const snapshot = await session.f.boundary.readNotionCandidateSnapshot(session.f.source, session.f.root);
    expect(snapshot.kind).toBe("snapshot");
    if (snapshot.kind !== "snapshot") throw new Error("Expected the completed full catalog");
    expect(snapshot.candidates.map(candidate => candidate.origin === "notion" ? candidate.record.name : "unexpected").sort())
      .toEqual(["independent", "required", "root", "second"]);
    expect(JSON.stringify(result.payload)).toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).toContain("Complete required instructions A.");
    await session.tool("notion_list").execute("catalog-after-write", {}, undefined, undefined, session.ctx);
    expect(trace.filter(value => value === "catalog")).toHaveLength(1);
  } finally { await session.close(); }
});

test("a partial post-management catalog cannot release preparation or stand in for a full directory", async () => {
  const { session, trace, setRefresh } = await fixture();
  setRefresh(async () => { session.f.state.catalog.coverage.exhaustive = false; });
  try {
    const result = await session.turn("Use $root@notion").then(value => ({ value }), error => ({ error }));
    expect(trace).toEqual(["missing-current-schema", "management", "catalog"]);
    expect(session.selected()?.scopes.size ?? 0).toBe(0);
    expect(JSON.stringify(result)).not.toContain("Complete root instructions A.");
  } finally { await session.close(); }
});

test.each(["abort", "session switch"] as const)("%s during catalog rebuilding prevents late preparation publication and consumption", async mode => {
  const { session, trace, setRefresh } = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  setRefresh(async () => { entered.resolve(); await release.promise; });
  try {
    const pending = session.turn("Use $root@notion").then(value => ({ value }), error => ({ error }));
    await entered.promise;
    if (mode === "abort") session.ctx.abort?.();
    else session.ctx.sessionManager!.getSessionId = () => "switched-session";
    release.resolve();
    await pending;
    expect(trace).toEqual(["missing-current-schema", "management", "catalog"]);
    expect(session.selected()?.scopes.size ?? 0).toBe(0);
  } finally { release.resolve(); await session.close(); }
});

test("a complete catalog from another authentication scope cannot release the materialized input", async () => {
  const { session, trace, setRefresh } = await fixture();
  setRefresh(async () => { session.f.state.catalog.scope = "f".repeat(64); });
  try {
    await session.turn("Use $root@notion").then(value => ({ value }), error => ({ error }));
    expect(trace).toEqual(["missing-current-schema", "management", "catalog"]);
    expect(session.selected()?.scopes.size ?? 0).toBe(0);
  } finally { await session.close(); }
});

test("a newer metadata refresh reobserves the catalog without cancelling or retargeting the accepted turn", async () => {
  const { session, trace, setRefresh } = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let refreshes = 0;
  setRefresh(async () => { if (++refreshes === 1) { entered.resolve(); await release.promise; } });
  try {
    const pending = session.turn("Use $root@notion");
    await entered.promise;
    await session.tool("notion_list").execute("newer-metadata", { refresh: true }, undefined, undefined, session.ctx);
    release.resolve();
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.provider).toBe(true);
    expect(trace.filter(value => value === "management")).toHaveLength(1);
    expect(trace.filter(value => value === "catalog").length).toBeGreaterThan(1);
    expect(trace.at(-1)).toBe("consume");
    expect(JSON.stringify(result.payload)).toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).toContain("Complete required instructions A.");
  } finally { release.resolve(); await session.close(); }
});


/** Drive the real production timers and monotonic clock without waiting minutes.
 * SDK/session boundaries remain the same as the other tests in this file. */
function preparationClock() {
  let now = 0;
  const nativeTimeout = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run(): void }>();
  const firstTimer = Promise.withResolvers<void>();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    if (delay === undefined || delay < 1_000) return nativeTimeout(callback, delay, ...args);
    const timer = nativeTimeout(() => {}, 2_147_483_647); timer.unref();
    timers.set(timer, { at: now + delay, run: () => callback(...args) });
    firstTimer.resolve();
    return timer;
  });
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(handle => {
    for (const timer of timers.keys()) if (timer === handle) timers.delete(timer);
    nativeClear(handle);
  });
  return {
    armed: firstTimer.promise,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); nativeClear(next[0]); next[1].run();
      }
      now = target;
    },
    jump(ms: number) { now += ms; },
    elapsed: () => now,
    restore() { for (const timer of timers.keys()) nativeClear(timer); clear.mockRestore(); timeout.mockRestore(); clock.mockRestore(); },
  };
}

test("authorized slow management and its catalog and body checks share the preparation episode", async () => {
  const { session, trace, setManagement, setRefresh, setConsume } = await fixture();
  const clock = preparationClock();
  setManagement(async () => { clock.advance(53_000); });
  setRefresh(async () => { clock.advance(8_000); });
  setConsume(async () => { clock.advance(5_000); });
  try {
    const result = await session.turn("Use $root@notion");
    expect(clock.elapsed()).toBe(66_000);
    expect(result.error).toBeUndefined(); expect(result.provider).toBe(true);
    expect(trace.slice(0, 4)).toEqual(["missing-current-schema", "management", "catalog", "consume"]);
    expect(JSON.stringify(result.payload)).toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).toContain("Complete required instructions A.");
  } finally { clock.restore(); await session.close(); }
});

test("same-session Stop cannot append a late management receipt after the context wait ends", async () => {
  const { session, trace, setManagement } = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  setManagement(async () => { entered.resolve(); await release.promise; });
  let pending: ReturnType<typeof session.turn> | undefined;
  try {
    pending = session.turn("Use $root@notion");
    await entered.promise; session.ctx.abort?.();
    const result = await pending;
    expect(result.provider).toBe(false);
    const before = structuredClone(session.branch);
    release.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(trace).toEqual(["missing-current-schema", "management"]);
    expect(session.branch).toEqual(before);
    expect(session.branch.filter(entry => entry.type === "custom" && entry.customType === "context-broker-materialization")).toEqual([]);
    expect(session.selected()?.scopes.size ?? 0).toBe(0);
  } finally { release.resolve(); await pending; await session.close(); }
});


test.each(["management", "catalog", "consume"] as const)("a stalled %s producer cannot outlive its cumulative context budget", async phase => {
  const { session, trace, setManagement, setRefresh, setConsume } = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const clock = preparationClock();
  const hold = async () => { entered.resolve(); await release.promise; };
  setManagement(phase === "management" ? hold : async () => { clock.advance(53_000); });
  if (phase === "catalog") setRefresh(hold);
  if (phase === "consume") setConsume(hold);
  let pending: ReturnType<typeof session.turn> | undefined;
  try {
    pending = session.turn("Use $root@notion");
    await entered.promise;
    clock.advance(phase === "management" ? 180_001 : phase === "catalog" ? 60_001 : 127_001);
    const result = await pending;
    expect(result.aborted).toBe(false);
    expect(JSON.stringify(result.payload)).toContain("SOURCE_PREPARATION_TIMEOUT");
    expect(JSON.stringify(result.payload)).not.toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).not.toContain("Complete required instructions A.");
    expect(session.selected()?.scopes.size ?? 0).toBe(0);
    const before = structuredClone(session.branch);
    release.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.branch).toEqual(before);
    expect(trace.filter(value => value === "management")).toHaveLength(1);
  } finally { release.resolve(); await pending; clock.restore(); await session.close(); }
});

test("directed discovery and complete catalog share the materialization episode instead of exhausting ordinary reads", async () => {
  const { session, trace, setManagement, setRefresh } = await fixture();
  const clock = preparationClock(), discover = session.f.state.sourceMembers;
  session.f.state.sourceMembers = async input => { clock.advance(30_000); return discover(input); };
  setManagement(async () => { clock.advance(53_000); });
  setRefresh(async () => { clock.advance(31_000); });
  try {
    const result = await session.turn("Use $root@notion");
    expect(clock.elapsed()).toBe(114_000);
    expect(result.error).toBeUndefined(); expect(result.provider).toBe(true);
    expect(trace).toEqual(["missing-current-schema", "management", "catalog", "consume"]);
    expect(JSON.stringify(result.payload)).toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).toContain("Complete required instructions A.");
  } finally { clock.restore(); await session.close(); }
});

test("multiple explicit roots share one preparation allowance and cannot dispatch a root after it expires", async () => {
  const { session, trace, setManagement } = await fixture(["root", "second", "independent"]);
  const clock = preparationClock(), targets: string[] = [];
  setManagement(async request => { targets.push(request.target.expected_skill_id); clock.advance(targets.length === 1 ? 100_000 : 81_000); });
  try {
    const result = await session.turn("Use $root@notion $second@notion $independent@notion");
    expect(clock.elapsed()).toBe(181_000);
    expect(targets).toEqual(["entry", "second"]);
    expect(trace.filter(value => value === "management")).toHaveLength(2);
    expect(JSON.stringify(result.payload)).toContain("SOURCE_PREPARATION_TIMEOUT");
    expect(JSON.stringify(result.payload)).not.toContain("Complete root instructions A.");
    expect(session.selected()?.scopes.size ?? 0).toBe(0);
  } finally { clock.restore(); await session.close(); }
});

for (const phase of ["management", "catalog", "consume"] as const)
test.each(["Stop", "session switch"] as const)("%s during " + phase + " prevents any late session or body publication", async mode => {
  const { session, setManagement, setRefresh, setConsume } = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const hold = async () => { entered.resolve(); await release.promise; };
  if (phase === "management") setManagement(hold);
  if (phase === "catalog") setRefresh(hold);
  if (phase === "consume") setConsume(hold);
  let pending: ReturnType<typeof session.turn> | undefined;
  try {
    pending = session.turn("Use $root@notion"); await entered.promise;
    if (mode === "Stop") session.ctx.abort?.();
    else { await session.emit("session_before_switch", { reason: "new" }); session.ctx.sessionManager!.getSessionId = () => "new-session"; }
    const result = await pending;
    expect(JSON.stringify(result.payload)).not.toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).not.toContain("Complete required instructions A.");
    const before = structuredClone(session.branch);
    release.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.branch).toEqual(before);
    expect(session.selected()?.scopes.size ?? 0).toBe(0);
  } finally { release.resolve(); await pending; await session.close(); }
});

test("fresh explicit discovery and normal graph consumption share the same preparation episode", async () => {
  const { session, trace, candidate, scope, setManagement } = await fixture();
  session.f.state.sourceMembers = async () => ({ version: 1, library_id: session.f.source.library, scope, coverage: "complete",
    candidates: [{ ...candidate, name: "fresh-member", alias: "fresh-member", record: undefined }], failures: [], effects: { remote_writes: "none" } });
  const clock = preparationClock();
  setManagement(async () => { clock.advance(65_000); });
  try {
    const result = await session.turn("Use $fresh-member@notion");
    expect(trace.slice(0, 3)).toEqual(["management", "catalog", "consume"]);
    expect(result.error).toBeUndefined(); expect(result.provider).toBe(true);
    expect(JSON.stringify(result.payload)).toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).toContain("Complete required instructions A.");
  } finally { clock.restore(); await session.close(); }
});

test("expired read time cannot enter Source preparation when the timer callback has not run", async () => {
  const clock = preparationClock(), parent = new AbortController(); let dispatched = 0;
  try {
    await expect(withContextPreparationDeadline(parent.signal, async (_signal, budget) => {
      clock.jump(60_001);
      return budget.withSourcePreparation(async preparation => { preparation.begin(); dispatched++; return "unexpected"; });
    })).rejects.toMatchObject({ code: "SOURCE_PREPARATION_TIMEOUT" });
    expect(dispatched).toBe(0); expect(parent.signal.aborted).toBe(false);
  } finally { clock.restore(); }
});

test("an expired manager response still reaches fact invalidation while the context reports timeout", async () => {
  const clock = preparationClock(), parent = new AbortController(), received = Promise.withResolvers<void>();
  const receipts: string[] = [];
  try {
    await expect(withContextPreparationDeadline(parent.signal, async (signal, budget) => budget.withSourcePreparation(async preparation => {
      preparation.begin();
      const receipt = await (async () => { clock.jump(180_001); return "durable-receipt"; })()
        .finally(() => preparation.checkpoint());
      receipts.push(receipt); expect(signal.aborted).toBe(true); received.resolve();
    }))).rejects.toMatchObject({ code: "SOURCE_PREPARATION_TIMEOUT" });
    await received.promise;
    expect(receipts).toEqual(["durable-receipt"]); expect(parent.signal.aborted).toBe(false);
  } finally { clock.restore(); }
});

test("context completion checks elapsed time before accepting a producer ahead of its overdue timer", async () => {
  const clock = preparationClock();
  try {
    await expect(withContextPreparationDeadline(new AbortController().signal, async () => {
      clock.jump(60_001); return "overdue-content";
    })).rejects.toMatchObject({ code: "SOURCE_PREPARATION_TIMEOUT" });
  } finally { clock.restore(); }
});

test("a completed context closes preparation capability without aborting its successful read signal", async () => {
  let dispatched = 0;
  const { signal, budget } = await withContextPreparationDeadline(new AbortController().signal, async (signal, budget) => ({ signal, budget }));
  expect(signal.aborted).toBe(false);
  await expect(budget.withSourcePreparation(async preparation => { preparation.begin(); dispatched++; })).rejects.toMatchObject({ code: "SOURCE_ACTIVATION_CANCELLED" });
  expect(dispatched).toBe(0);
});

test("nested preparation scopes cannot dispatch or renew a context allowance", async () => {
  let dispatched = 0;
  await withContextPreparationDeadline(new AbortController().signal, async (_signal, budget) => {
    await budget.withSourcePreparation(async preparation => {
      preparation.begin();
      await expect(budget.withSourcePreparation(async preparation => { preparation.begin(); dispatched++; })).rejects.toMatchObject({ code: "SOURCE_ACTIVATION_CANCELLED" });
    });
  });
  expect(dispatched).toBe(0);
});


test("native root Requires repair carries the accepted preparation scope through dependency management", async () => {
  const { session, trace, root, required, candidate, scope, setManagement } = await fixture(["required"]);
  if (root.locator.type !== "shared_skill" || required.locator.type !== "shared_skill") throw new Error("Expected physical Skills");
  const authorization = { skill_id: root.locator.skill_id, page_id: root.locator.page_id, requires_digest: "e".repeat(64) };
  const dependency = { ...candidate, name: "required", alias: "required", expected_skill_id: required.locator.skill_id,
    member_key: "skills/required", record: required };
  session.f.state.sourceMembers = async input => ({ version: 1, library_id: session.f.source.library, scope, coverage: "complete",
    ...(input.requires_of ? { root, authorization_root: authorization } : {}), candidates: input.requires_of ? [dependency] : [],
    failures: [], effects: { remote_writes: "none" } });
  const clock = preparationClock();
  setManagement(async request => { expect(request.authorization_root).toEqual(authorization); clock.advance(65_000); });
  try {
    const result = await session.turn("Use $root@notion");
    expect(trace.slice(0, 4)).toEqual(["missing-current-schema", "management", "catalog", "consume"]);
    expect(result.error).toBeUndefined(); expect(result.provider).toBe(true);
    expect(JSON.stringify(result.payload)).toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).toContain("Complete required instructions A.");
  } finally { clock.restore(); await session.close(); }
});


test("cold literal materialization keeps discovery, catalog persistence and final consume in one bounded preparation", async () => {
  const listed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const { session, trace, setManagement, setRefresh, setConsume } = await fixture(["root"], {
    warmCatalog: false,
    beforeStart(f) {
      const list = f.state.list.bind(f.state);
      let first = true;
      f.state.list = async options => {
        if (first) { first = false; listed.resolve(); await release.promise; }
        return list(options);
      };
    },
  });
  await listed.promise;
  const clock = preparationClock(), consume = session.f.state.consume, discover = session.f.state.sourceMembers;
  let cold = true;
  session.f.state.consume = async (input, options) => {
    if (cold) { cold = false; clock.advance(13_309); }
    return consume(input, options);
  };
  session.f.state.sourceMembers = async input => { trace.push("source-discovery"); clock.advance(14_000); return discover(input); };
  setManagement(async () => { clock.advance(53_000); });
  setRefresh(async () => { clock.advance(36_000); });
  setConsume(async () => { clock.advance(15_000); });
  let pending: ReturnType<typeof session.turn> | undefined;
  try {
    expect(session.f.calls.some(call => call.operation === "consume")).toBe(false);
    pending = session.turn("Use $root@notion", [], undefined, undefined, [], { status: 200 });
    await clock.armed;
    clock.advance(36_039); release.resolve();
    const result = await pending;
    expect(result.error).toBeUndefined(); expect(result.provider).toBe(true);
    expect(trace).toEqual(["missing-current-schema", "source-discovery", "management", "catalog", "consume"]);
    expect(clock.elapsed()).toBe(167_348);
    expect(JSON.stringify(result.payload)).toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).toContain("Complete required instructions A.");
    expect(session.selected()?.scopes.size).toBe(1);
  } finally { release.resolve(); await pending; clock.restore(); await session.close(); }
});


test.each(["discovery", "management", "catalog", "consume"] as const)("an overdue %s response cannot publish before its timer callback runs", async phase => {
  const { session, trace, setManagement, setRefresh, setConsume } = await fixture();
  const clock = preparationClock(), discover = session.f.state.sourceMembers;
  if (phase === "discovery") session.f.state.sourceMembers = async input => { clock.jump(180_001); return discover(input); };
  setManagement(async () => { if (phase === "management") clock.jump(180_001); else if (phase !== "discovery") clock.advance(100_000); });
  if (phase === "catalog") setRefresh(async () => { clock.jump(80_001); });
  if (phase === "consume") setConsume(async () => { clock.jump(80_001); });
  try {
    const result = await session.turn("Use $root@notion");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.stringify(result.payload)).toContain("SOURCE_PREPARATION_TIMEOUT");
    expect(JSON.stringify(result.payload)).not.toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).not.toContain("Complete required instructions A.");
    expect(session.selected()?.scopes.size ?? 0).toBe(0);
    expect(trace.includes("management")).toBe(phase !== "discovery");
    expect(trace.includes("catalog")).toBe(phase === "catalog" || phase === "consume");
    expect(trace.includes("consume")).toBe(phase === "consume");
    if (phase === "management") expect(session.branch.filter(entry => entry.customType === "context-broker-materialization")).toEqual([]);
  } finally { clock.restore(); await session.close(); }
});

test.each(["Stop", "session switch"] as const)("%s during directed discovery cannot dispatch a late manager", async mode => {
  const { session, trace } = await fixture();
  const discover = session.f.state.sourceMembers, entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  session.f.state.sourceMembers = async input => { entered.resolve(); await release.promise; return discover(input); };
  let pending: ReturnType<typeof session.turn> | undefined;
  try {
    pending = session.turn("Use $root@notion"); await entered.promise;
    if (mode === "Stop") session.ctx.abort?.();
    else { await session.emit("session_before_switch", { reason: "new" }); session.ctx.sessionManager!.getSessionId = () => "new-session"; }
    const result = await pending, before = structuredClone(session.branch);
    release.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(trace).toEqual(["missing-current-schema"]);
    expect(session.branch).toEqual(before);
    expect(JSON.stringify(result.payload)).not.toContain("Complete root instructions A.");
    expect(session.selected()?.scopes.size ?? 0).toBe(0);
  } finally { release.resolve(); await pending; await session.close(); }
});

test.each(["unmatched", "blocked", "failed"] as const)("%s Source preparation returns the remaining read allowance to later ordinary work", async outcome => {
  const clock = preparationClock(), parent = new AbortController();
  try {
    await expect(withContextPreparationDeadline(parent.signal, async (signal, budget) => {
      clock.advance(59_000);
      try {
        await budget.withSourcePreparation(async preparation => {
          preparation.begin(); clock.advance(30_000);
          if (outcome === "failed") throw new Error("Discovery failed");
          return outcome;
        });
      } catch (error) { if (outcome !== "failed") throw error; }
      expect(signal.aborted).toBe(false);
      clock.advance(1_001);
    })).rejects.toMatchObject({ code: "SOURCE_PREPARATION_TIMEOUT" });
    expect(parent.signal.aborted).toBe(false);
  } finally { clock.restore(); }
});

test("queued preparation scopes and repeated begin calls share one cumulative allowance", async () => {
  const clock = preparationClock(); let entered = 0;
  try {
    await expect(withContextPreparationDeadline(new AbortController().signal, async (_signal, budget) => {
      await budget.withSourcePreparation(async preparation => { entered++; preparation.begin(); clock.advance(100_000); });
      await budget.withSourcePreparation(async preparation => {
        entered++; preparation.begin(); clock.advance(40_000); preparation.begin(); clock.advance(40_001);
      });
      await budget.withSourcePreparation(async preparation => { preparation.begin(); entered++; });
    })).rejects.toMatchObject({ code: "SOURCE_PREPARATION_TIMEOUT" });
    expect(entered).toBe(2);
  } finally { clock.restore(); }
});

test("a returned scope cannot begin or expire the next input through a late checkpoint", async () => {
  const clock = preparationClock(); let previous: SourcePreparationScope | undefined;
  try {
    await expect(withContextPreparationDeadline(new AbortController().signal, async (signal, budget) => {
      await budget.withSourcePreparation(async preparation => { previous = preparation; preparation.begin(); });
      if (!previous) throw new Error("Expected a completed preparation scope");
      expect(() => previous!.begin()).toThrow("Skill preparation cancelled");
      await budget.withSourcePreparation(async preparation => {
        preparation.begin(); clock.jump(180_001);
        previous!.checkpoint();
        expect(signal.aborted).toBe(false);
        preparation.checkpoint();
        expect(signal.aborted).toBe(true);
      });
    })).rejects.toMatchObject({ code: "SOURCE_PREPARATION_TIMEOUT" });
  } finally { clock.restore(); }
});

test("overlapping preparation scopes reject before their producer runs", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let overlap = 0;
  await withContextPreparationDeadline(new AbortController().signal, async (_signal, budget) => {
    const pending = budget.withSourcePreparation(async preparation => { preparation.begin(); entered.resolve(); await release.promise; });
    try {
      await entered.promise;
      await expect(budget.withSourcePreparation(async preparation => { preparation.begin(); overlap++; }))
        .rejects.toMatchObject({ code: "SOURCE_ACTIVATION_CANCELLED" });
    } finally { release.resolve(); await pending; }
  });
  expect(overlap).toBe(0);
});

test("an already-ready member discovered from a literal miss still completes its preparation without a manager", async () => {
  const { session, trace, candidate, scope } = await fixture();
  const clock = preparationClock();
  session.f.state.sourceMembers = async () => {
    clock.advance(30_000);
    return { version: 1, library_id: session.f.source.library, scope, coverage: "complete", failures: [], effects: { remote_writes: "none" },
      candidates: [{ ...candidate, name: "fresh-member", alias: "fresh-member", readiness: "ready" }] };
  };
  session.f.state.consume = async input => { clock.advance(35_000); return session.ready(input); };
  try {
    const result = await session.turn("Use $fresh-member@notion");
    expect(clock.elapsed()).toBe(65_000);
    expect(result.error).toBeUndefined(); expect(result.provider).toBe(true);
    expect(trace).toEqual([]);
    expect(JSON.stringify(result.payload)).toContain("Complete root instructions A.");
    expect(JSON.stringify(result.payload)).toContain("Complete required instructions A.");
  } finally { clock.restore(); await session.close(); }
});
