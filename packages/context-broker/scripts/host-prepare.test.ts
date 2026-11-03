import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHostSkills, type HostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { deduplicateSourceReads, sourceDeliveryReceipt, sourceBodyLoaded, sessionSourceBindings } from "../src/session-source-snapshot";
import type { PreparedHostGraph, PreparationPurpose } from "../src/prepare-protocol";
import type { ContentRecord, ExtensionAPI, ExtensionContext, NativeSkillPrepareDefinition, NativeSkillSearchDefinition, SkillRecord } from "../src/types";
import type { SelectionMode } from "../src/session-graph";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
}
const scope = "a".repeat(64);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "broker-host-prepare-"));
  const records: SkillRecord[] = [];
  for (const [index, name] of ["root", "required", "member"].entries()) {
    const id = "shared_skill:controlled:" + name;
    const metadata: ContentRecord = {
      id, kind: "skill", name, alias: name, description: "Controlled " + name, enabled: true, default_context: index === 0,
      entrypoint: "SKILL.md", ref: "skill://" + encodeURIComponent(id) + "/SKILL.md",
      locator: { type: "shared_skill", library_id: "controlled", skill_id: name, page_id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
        database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" },
    };
    const body = "\ufeff---\r\nname: " + name + "\r\n---\r\nExact " + name + " <instructions>.\r\n";
    const snapshotId = "s_" + hash(name), path = join(directory, name + ".md");
    await writeFile(path, body);
    records.push({
      ...metadata, source: "notion", sourceId: "controlled", sourceScope: scope, body, path, snapshotId, versionId: hash(body),
      aliases: [], normalizedAliases: [], normalizedName: name, normalizedDescription: metadata.description, autoloadEnabled: true, defaultDiscovery: false,
      preparationBinding: { record: metadata, scope, snapshot_id: snapshotId, version_id: hash(body), body_sha256: hash(body), ref: metadata.ref + "?snapshot=" + snapshotId },
      preparationDirectory: { files: [], required: [], candidates: [], references: [] },
    });
  }
  const [root, required, member] = records;
  root!.preparationDirectory!.candidates = [{ id: member!.id!, ref: member!.ref!, kind: "skill", name: member!.name, description: member!.description, availability: "available" }];
  const ctx: ExtensionContext = { cwd: directory, hasUI: false, mode: "rpc" };
  const calls: PreparationPurpose[] = [];
  const persisted: SelectionMode[] = [];
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  let search: NativeSkillSearchDefinition | undefined, tool: NativeSkillPrepareDefinition | undefined;
  const api: ExtensionAPI = { on(name, listener) { events.set(name, [...events.get(name) ?? [], listener]); }, registerTool(value) { if (value.name === "skill_search") search = value; if (value.name === "skill_prepare") tool = value; } };
  function graph(purpose: PreparationPurpose): PreparedHostGraph {
    const selected = purpose === "use" ? [root!, required!] : [root!];
    const vector = { version: 1 as const, kind: "observed_version_vector" as const, purpose, scope, roots: [root!.id!],
      required: purpose === "use" ? [{ from: root!.id!, to: required!.id!, ref: required!.preparationBinding!.ref }] : [],
      bindings: selected.map(record => record.preparationBinding!) };
    return { purpose, sourceId: "controlled", scope, roots: [root!.id!], records: selected, bindings: selected.map(record => record.preparationBinding!), lock: { ...vector, sha256: hash(canonical(vector)) },
      budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
      usage: { prepared_nodes: selected.length, instruction_bytes: selected.reduce((n, record) => n + Buffer.byteLength(record.body!), 0), context_bytes: 4000, max_depth: purpose === "use" ? 1 : 0 } };
  }
  const install = async (prepareGraph: (purpose: PreparationPurpose, signal?: AbortSignal) => Promise<PreparedHostGraph[]> = async purpose => [graph(purpose)]) => {
    let host: HostSkills;
    host = await installHostSkills(api, {
      config: { sources: [{ id: "controlled", type: "notion", prefetch: false }] },
      getRecords: async () => ({ records: records.map(record => ({ ...record, body: undefined, preparationBinding: undefined })), failures: [] }),
      loadRecord: async () => { throw new Error("Graph roots must use the CLI preparation bridge"); },
      prepareGraph: async (_records, _ctx, signal, purpose) => { calls.push(purpose); return prepareGraph(purpose, signal); },
      persistGraphs: (_graphs, _ctx, mode) => { persisted.push(mode); },
      needsPreflightPrompt: text => text.includes("$root"),
      preflightPrompt: async (text, ctx, signal) => { if (text.includes("$root")) await host.prepareMany([root!], ctx, signal); },
    }, createPiHostAdapter(api));
    if (!search || !tool) throw new Error("Expected native graph tools");
    return { search, tool, host };
  };
  const emit = async (name: string, value: unknown, ctx: ExtensionContext) => {
    const results = [];
    for (const listener of events.get(name) ?? []) results.push(await listener(value as never, ctx));
    return results;
  };
  return { ctx, records, root: root!, required: required!, member: member!, graph, calls, persisted, install, emit };
}
test("native metadata search stays known; explicit inspect and use deliver complete bodies with separate intent", async () => {
  const f = await fixture(), { search, tool } = await f.install();
  const directory = await search.execute("search", { query: "member" }, undefined, undefined, f.ctx);
  const metadata = JSON.parse(String(directory.content[0]?.type === "text" ? directory.content[0].text : ""));
  expect(metadata.state).toBe("known"); expect(metadata.records[0].ref).toBe(f.member.ref);
  expect(JSON.stringify(metadata)).not.toContain("Exact member"); expect(f.calls).toEqual([]);
  const inspected = await tool.execute("inspect", { roots: [f.root.ref], purpose: "inspect" }, undefined, undefined, f.ctx);
  const inspection = JSON.parse(String(inspected.content[0]?.type === "text" ? inspected.content[0].text : ""));
  expect(inspection.records).toHaveLength(1); expect(inspection.records[0].content).toBe(f.root.body);
  expect(inspection.records[0].directory.candidates[0].ref).toBe(f.member.ref);
  const used = await tool.execute("use", { roots: [f.root.ref], purpose: "use" }, undefined, undefined, f.ctx);
  const usage = JSON.parse(String(used.content[0]?.type === "text" ? used.content[0].text : ""));
  expect(usage.records.map((record: { id: string }) => record.id)).toEqual([f.root.id, f.required.id]);
  expect(f.calls).toEqual(["inspect", "use"]);
  expect(sourceBodyLoaded([], f.root)).toBe(false);
  const result = { role: "toolResult", toolName: "skill_prepare", toolCallId: "use", content: used.content, details: used.details, isError: false };
  expect(sourceBodyLoaded([result], f.root)).toBe(true); expect(sourceBodyLoaded([result], f.required)).toBe(true);
  expect(sourceBodyLoaded([result], f.member)).toBe(false);
  expect(sessionSourceBindings([result], scope).map(binding => binding.record.id)).toEqual([f.root.id!, f.required.id!]);
  expect(sourceBodyLoaded([{ ...result, content: "compacted" }], f.root)).toBe(false);
  expect(sourceBodyLoaded([{ ...result, isError: true }], f.root)).toBe(false);
});
test("one cancelled native preparation cannot cancel another waiter or return late bodies", async () => {
  const f = await fixture(), pending = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const observed: AbortSignal[] = [];
  const { tool } = await f.install(async (purpose, signal) => { if (signal) observed.push(signal); if (observed.length === 2) started.resolve(); await pending.promise; return [f.graph(purpose)]; });
  const first = new AbortController(), second = new AbortController();
  const one = tool.execute("one", { roots: [f.root.ref], purpose: "use" }, first.signal, undefined, f.ctx).then(() => "ready", () => "cancelled");
  const two = tool.execute("two", { roots: [f.root.ref], purpose: "use" }, second.signal, undefined, f.ctx);
  await started.promise; first.abort();
  expect(observed[0]?.aborted).toBe(true); expect(observed[1]?.aborted).toBe(false);
  pending.resolve();
  expect(await one).toBe("cancelled");
  expect((await two).isError).not.toBe(true);
});

test("failed exact-file validation and output budget do not commit an explicit refreshed selection", async () => {
  const f = await fixture(), { tool } = await f.install();
  await expect(tool.execute("invalid", { roots: [f.root.ref + "?file_id=foreign"], purpose: "use", refresh: true }, undefined, undefined, f.ctx)).rejects.toThrow();
  expect(f.persisted).toEqual([]);
  const g = await fixture(), tiny = await g.install(async purpose => [{ ...g.graph(purpose), budget: { ...g.graph(purpose).budget, maxContextBytes: 1 } }]);
  await expect(tiny.tool.execute("budget", { roots: [g.root.ref], purpose: "use", refresh: true }, undefined, undefined, g.ctx)).rejects.toThrow("PREPARE_CONTEXT_BUDGET");
  expect(g.persisted).toEqual([]);
  await tool.execute("ready", { roots: [f.root.ref], purpose: "use", refresh: true }, undefined, undefined, f.ctx);
  expect(f.persisted).toEqual(["replace"]);
});

test("session replacement settles a pending Pi input without touching the revoked context", async () => {
  const f = await fixture(), started = Promise.withResolvers<void>(), pending = Promise.withResolvers<void>();
  let sourceSignal: AbortSignal | undefined;
  await f.install(async (purpose, signal) => { sourceSignal = signal; started.resolve(); await pending.promise; return [f.graph(purpose)]; });
  let revoked = false, staleReads = 0;
  const old = new Proxy({ ...f.ctx, sessionManager: { getSessionId: () => "old" } }, {
    get(target, key, receiver) { if (revoked) { staleReads++; throw new Error("extension ctx is stale after session replacement"); } return Reflect.get(target, key, receiver); },
  });
  const preparation = f.emit("input", { source: "rpc", text: "$root task" }, old);
  await started.promise;
  await f.emit("session_before_switch", { type: "session_before_switch" }, old);
  revoked = true;
  const next = { ...f.ctx, sessionManager: { getSessionId: () => "next" } };
  await f.emit("session_switch", { type: "session_switch" }, next);
  expect(sourceSignal?.aborted).toBe(true);
  pending.resolve();
  expect(await preparation).toEqual([{ action: "handled" }]);
  expect(staleReads).toBe(0);
  expect(f.persisted).toEqual([]);
  expect(await f.emit("input", { source: "rpc", text: "$root retry" }, next)).toEqual([{ action: "continue" }]);
  expect(f.persisted).toEqual(["extend"]);
});

test("repeated native prepare bodies deduplicate only the provider projection and keep following receipt offsets valid", async () => {
  const f = await fixture(), { tool } = await f.install();
  const used = await tool.execute("first", { roots: [f.root.ref], purpose: "use" }, undefined, undefined, f.ctx);
  const first = { role: "toolResult", toolName: "skill_prepare", toolCallId: "first", content: used.content, details: used.details, isError: false };
  const text = JSON.stringify({ records: [{ content: f.root.body }, { content: f.member.body }] });
  const second = { role: "toolResult", toolName: "skill_prepare", toolCallId: "second", content: [{ type: "text" as const, text }],
    details: { contextBrokerPreparation: { version: 1, toolCallId: "second", records: [f.root, f.member].map(record =>
      sourceDeliveryReceipt(record, text, "json", text.indexOf(JSON.stringify(record.body)) + 1)) } }, isError: false };
  const original = JSON.stringify([first, second]);
  const projected = deduplicateSourceReads([first, second]);
  expect(JSON.stringify(projected).split("Exact root <instructions>.").length - 1).toBe(1);
  expect(sourceBodyLoaded(projected, f.root)).toBe(true);
  expect(sourceBodyLoaded(projected, f.member)).toBe(true);
  expect(JSON.stringify([first, second])).toBe(original);
  expect(second.content[0]!.text).toContain("Exact root");
});
