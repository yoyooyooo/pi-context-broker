import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { activeNotionSession } from "./fixtures/active-notion-session";
import type { SourceMaterializationRequest, SourceMaterializationReceipt, SourceMemberCandidate } from "../src/source-materialization-contract";

/** The production index and host hooks run unchanged; only SDK operations and
 * the session are controlled. Real cross-PID SQLite/HTTP stays in the Pi gate. */
async function fixture() {
  const session = await activeNotionSession({ catalogMaxAgeMs: 300_000 });
  const { f } = session, scope = f.selected.sourceScope!;
  const root = session.record("root").preparationBinding!.record;
  const required = session.record("required").preparationBinding!.record;
  const candidate: SourceMemberCandidate = { type: "source_member", library_id: f.source.library!, scope,
    source_id: "registered-origin", member_key: "skills/root", expected_skill_id: "entry", registration_digest: "a".repeat(64),
    name: root.name, alias: root.alias, description: root.description, enabled: true, readiness: "materializable", record: root };
  const management = "export const SOURCE_MATERIALIZATION_VERSION=1, PACKAGE_VERSION='current-source-fixture';let handler;export function configure(value){handler=value;}export async function materializeSource(input){return handler(input);}";
  const path = join(f.root, "src/ntn-skills-management.mjs");
  await writeFile(path, management);
  const manifestPath = join(f.root, "src/ntn-skills-runtime.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, management_sha256: createHash("sha256").update(management).digest("hex") }));
  const manager: { configure(handler: (input: SourceMaterializationRequest) => Promise<SourceMaterializationReceipt>): void } = await import(pathToFileURL(path).href);
  let ready = false, persisted = true;
  const trace: string[] = [], list = f.state.list.bind(f.state), consume = f.state.consume.bind(f.state), candidates = f.state.candidates.bind(f.state);
  let refresh: () => Promise<void> = async () => {};
  manager.configure(async input => {
    trace.push("management"); ready = true; persisted = false;
    return { version: 1, request_id: input.request_id, library_id: input.library, scope, target: input.target,
      status: "ready", operation_id: "source-materialization", records: [root, required], affected_skill_ids: ["entry", "required"],
      source_revisions: [{ source_id: candidate.source_id, revision: "b".repeat(64) }], effects: { remote_writes: "management", projection: "none" } };
  });
  f.state.sourceMembers = async () => ({ version: 1, library_id: f.source.library, scope, coverage: "complete", candidates: [candidate], failures: [], effects: { remote_writes: "none" } });
  f.state.candidates = options => persisted ? candidates(options) : { kind: "miss", reason: "catalog_unavailable" };
  f.state.consume = async (input, options) => {
    trace.push(ready ? "consume" : "missing-current-schema");
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
  return { session, trace, root, required, scope, setRefresh: (run: () => Promise<void>) => { refresh = run; }, persisted: () => persisted };
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
