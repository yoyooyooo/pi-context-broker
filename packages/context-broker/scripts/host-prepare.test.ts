import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHostSkills, type HostSkills, type HostSkillOptions } from "../src/host-skills";
import { createActivationFeedback } from "../src/activation-feedback";
import { buildInjectedContextMessage } from "../src/index";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { createOmpHostAdapter } from "../src/omp-host-adapter";
import { deduplicateSourceReads, sourceDeliveryReceipt, sourceBodyLoaded, sourceMessageText, sessionSourceBindings } from "../src/session-source-snapshot";
import { materializeNotionEntryFile, publishNotionEntry } from "../src/notion-entry";
import type { PreparedHostGraph, PreparationPurpose } from "../src/prepare-protocol";
import type { AgentMessage, ContentRecord, ExtensionAPI, ExtensionContext, MessageContent, NativeSkillGraphDefinition, NativeSkillPrepareDefinition, NativeSkillSearchDefinition, SessionEntry, SkillRecord } from "../src/types";
import type { SelectionMode } from "../src/session-graph";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
}
const scope = "a".repeat(64);
function preparationDetails(result: { details?: unknown }): Record<string, unknown> {
  const details = result.details;
  if (!details || typeof details !== "object" || Array.isArray(details) || !("contextBrokerPreparation" in details)) throw new Error("Expected preparation details");
  const preparation = details.contextBrokerPreparation;
  if (!preparation || typeof preparation !== "object" || Array.isArray(preparation)) throw new Error("Expected preparation proof");
  return Object.fromEntries(Object.entries(preparation));
}
async function fixture(withShortRefs = false, withDirectoryAlias = false, hostKind: "pi" | "omp" = "pi") {
  const owned = await mkdtemp(join(tmpdir(), "broker-host-prepare-"));
  const directory = withDirectoryAlias ? join(owned, "alias") : owned;
  if (withDirectoryAlias) {
    await mkdir(join(owned, "canonical"));
    await symlink(join(owned, "canonical"), directory, "dir");
  }
  const records: SkillRecord[] = [];
  const resourceText = new Map<string, string>(), resourceReads: string[] = [];
  const ensure = async (path: string) => { await mkdir(path, { recursive: true }); };
  for (const [index, name] of ["root", "required", "member"].entries()) {
    const id = "shared_skill:controlled:" + name;
    const metadata: ContentRecord = {
      id, kind: "skill", name, alias: name, description: "Controlled " + name, enabled: true, default_context: index === 0,
      entrypoint: "SKILL.md", ref: "skill://" + encodeURIComponent(id) + "/SKILL.md",
      locator: { type: "shared_skill", library_id: "controlled", skill_id: name, page_id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
        database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" },
    };
    const body = "\ufeff---\r\nname: " + name + "\r\n---\r\nExact " + name + " <instructions>.\r\n";
    const snapshotId = "s_" + hash(name), path = join(directory, name, "SKILL.md");
    await mkdir(join(directory, name), { recursive: true });
    await writeFile(path, body);
    let selected: SkillRecord = {
      ...metadata, source: "notion", sourceId: "controlled", sourceScope: scope, body, path, snapshotId, versionId: hash(body),
      aliases: [], normalizedAliases: [], normalizedName: name, normalizedDescription: metadata.description, autoloadEnabled: true, defaultDiscovery: false,
      preparationBinding: { record: metadata, scope, snapshot_id: snapshotId, version_id: hash(body), body_sha256: hash(body), ref: metadata.ref + "?snapshot=" + snapshotId },
      preparationDirectory: { files: [], required: [], candidates: [], references: [] },
    };
    if (withShortRefs) {
      const resource = "Exact " + name + " resource bytes.\r\n";
      resourceText.set(id, resource);
      selected.preparationBinding = { ...selected.preparationBinding!, ref: selected.preparationBinding!.ref + "&file_id=main-" + name };
      const files = [{ path: "SKILL.md", bytes: Buffer.byteLength(body), sha256: hash(body), ref: selected.preparationBinding.ref },
        { path: "resources/guide.md", bytes: Buffer.byteLength(resource), sha256: hash(resource),
          ref: metadata.ref.replace("SKILL.md", "resources/guide.md") + "?snapshot=" + snapshotId + "&file_id=guide-" + name }];
      selected.fileBindings = [
        { file_id: "main-" + name, path: "SKILL.md", page_id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0") },
        { file_id: "guide-" + name, path: "resources/guide.md", page_id: "00000000-0000-4000-8000-" + String(index + 100).padStart(12, "0") },
      ];
      selected.preparationDirectory = { ...selected.preparationDirectory!, files };
      selected = await publishNotionEntry(selected, files, join(directory, "immutable-cache"), ensure);
    }
    records.push(selected);
  }
  const [root, required, member] = records;
  root!.preparationDirectory!.candidates = [{ id: member!.id!, ref: member!.ref!, kind: "skill", name: member!.name, description: member!.description, availability: "available" }];
  const session = { entries: [] as SessionEntry[], id: "controlled-session" };
  const ctx: ExtensionContext = { cwd: directory, hasUI: false, mode: "rpc", ...(withShortRefs ? { sessionManager: {
    getBranch: () => session.entries, getSessionId: () => session.id, getSessionFile: () => join(directory, "controlled-session.jsonl"),
  } } : {}) };
  const calls: PreparationPurpose[] = [];
  const persisted: SelectionMode[] = [];
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  let search: NativeSkillSearchDefinition | undefined, tool: NativeSkillPrepareDefinition | undefined, graphTool: NativeSkillGraphDefinition | undefined;
  const api: ExtensionAPI = { ...(hostKind === "omp" ? { pi: {} } : {}), on(name, listener) { events.set(name, [...events.get(name) ?? [], listener]); },
    appendEntry(customType, data) { session.entries.push({ type: "custom", customType, data }); },
    registerTool(value) { if (value.name === "skill_search" || value.name === "notion_list") search = value; if (value.name === "skill_prepare" || value.name === "notion_use") tool = value; if (value.name === "skill_graph" || value.name === "notion_ctl") graphTool = value; } };
  function graph(purpose: PreparationPurpose): PreparedHostGraph {
    const selected = purpose === "use" ? [root!, required!] : [root!];
    const vector = { version: 1 as const, kind: "observed_version_vector" as const, purpose, scope, roots: [root!.id!],
      required: purpose === "use" ? [{ from: root!.id!, to: required!.id!, ref: required!.preparationBinding!.ref }] : [],
      bindings: selected.map(record => record.preparationBinding!) };
    return { purpose, sourceId: "controlled", scope, roots: [root!.id!], records: selected, bindings: selected.map(record => record.preparationBinding!), lock: { ...vector, sha256: hash(canonical(vector)) },
      budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
      usage: { prepared_nodes: selected.length, instruction_bytes: selected.reduce((n, record) => n + Buffer.byteLength(record.body!), 0), context_bytes: 4000, max_depth: purpose === "use" ? 1 : 0 } };
  }
  const install = async (prepareGraph: (purpose: PreparationPurpose, signal?: AbortSignal) => Promise<PreparedHostGraph[]> = async purpose => [graph(purpose)], discovery: Partial<Pick<HostSkillOptions, "getRecords" | "lookupReference">> = {}) => {
    let host: HostSkills;
    host = await installHostSkills(api, {
      config: { sources: [{ id: "controlled", type: "notion", prefetch: false }] },
      getRecords: async () => ({ records: records.map(record => ({ ...record, body: undefined, preparationBinding: undefined })), failures: [] }),
      ...discovery,
      loadRecord: async () => { throw new Error("Graph roots must use the CLI preparation bridge"); },
      loadResource: async (record, path, _ctx, signal) => materializeNotionEntryFile(record, path, ensure, async (file, output) => {
        const text = resourceText.get(record.id!);
        if (text === undefined || file.path !== "resources/guide.md") throw new Error("Unexpected fixture resource");
        resourceReads.push(file.ref);
        await writeFile(output, text);
      }, signal),
      prepareGraph: async (_records, _ctx, signal, purpose) => { calls.push(purpose); return prepareGraph(purpose, signal); },
      persistGraphs: (_graphs, _ctx, mode) => { persisted.push(mode); },
      ...(withShortRefs ? { sessionGraph: () => ({ kind: "controlled-selected-graph", scope }) } : {}),
      needsPreflightPrompt: text => text.includes("$root"),
      preflightPrompt: async (text, ctx, signal) => { if (text.includes("$root")) await host.prepareMany([root!], ctx, signal); },
    }, hostKind === "omp" ? createOmpHostAdapter(api) : createPiHostAdapter(api));
    if (!search || !tool) throw new Error("Expected native graph tools");
    return { search, tool, graphTool, host };
  };
  const emit = async (name: string, value: unknown, ctx: ExtensionContext) => {
    const results = [];
    for (const listener of events.get(name) ?? []) results.push(await listener(value as never, ctx));
    return results;
  };
  return { ctx, records, root: root!, required: required!, member: member!, graph, calls, persisted, install, emit, session, resourceText, resourceReads };
}
test("Pi preparation shows its budget immediately without queueing a session message", async () => {
  const f = await fixture();
  const widgets = new Map<string, string[]>(), messages: unknown[] = [], entries: unknown[] = [];
  const api: ExtensionAPI = { on() {}, sendMessage(message) { messages.push(message); }, appendEntry(_type, data) { entries.push(data); } };
  const feedback = await createActivationFeedback(api, () => {}, "widget");
  let session = "feedback-session", revoked = false;
  const context = new Proxy({ ...f.ctx, hasUI: true, mode: "tui" as const,
    ui: { setWidget(key: string, content: unknown) {
      if (content === undefined) widgets.delete(key);
      else {
        if (!Array.isArray(content) || content.some(line => typeof line !== "string")) throw new Error("Expected a text preparation widget");
        widgets.set(key, content);
      }
    } }, sessionManager: { getSessionId: () => session, getBranch: () => [] },
  }, { get(target, key, receiver) { if (revoked) throw new Error("Revoked feedback context"); return Reflect.get(target, key, receiver); } });
  const source = { type: "notion" as const, id: "controlled", preparation: { maxNodes: 8, maxDepth: 4, maxInstructionBytes: 8192, maxContextBytes: 131072 } };
  const finish = feedback.begin(f.root, context, "use", source);
  expect(finish).toBeDefined(); expect(widgets.size).toBe(1);
  expect([...widgets.values()][0]!.join("\n")).toContain("Preparing use: up to 8 nodes, depth 4, 8192 instruction bytes, 131072 context bytes. Stop cancels preparation.");
  expect(messages).toEqual([]);
  finish!({ error: "Cancelled." });
  expect(widgets.size).toBe(0); expect(entries).toHaveLength(1);
  finish!({ value: f.root }); expect(entries).toHaveLength(1);
  const late = feedback.begin(f.root, context, "use", source);
  expect(widgets.size).toBe(1);
  session = "replacement";
  feedback.restore({ ...context }); revoked = true;
  expect(widgets.size).toBe(0);
  late!({ value: f.root }); expect(entries).toHaveLength(1);
  expect(messages).toEqual([]);
});

test("exact use survives unrelated discovery errors while discovery remains failed", async () => {
  const f = await fixture();
  let lookups = 0;
  const { tool, search } = await f.install(undefined, {
    getRecords: async () => { throw Object.assign(new Error("Invalid unrelated catalog"), { code: "SOURCE_DISCOVERY_INVALID" }); },
    lookupReference: async () => {
      lookups++;
      return { records: f.records, failures: [{ sourceId: "other", namespace: "other", type: "notion", code: "ACCESS_DENIED", message: "Unrelated source" }] };
    },
  });
  await expect(search.execute("discovery", {}, undefined, undefined, f.ctx)).rejects.toMatchObject({ code: "SOURCE_DISCOVERY_INVALID" });
  const used = await tool.execute("exact-use", { ref: f.root.ref }, undefined, undefined, f.ctx);
  const content = sourceMessageText(used.content);
  const projected = JSON.parse(content);
  expect(projected.records.map((value: { content: string }) => value.content)).toEqual([f.root.body, f.required.body]);
  expect(content).not.toContain(f.member.body!);
  expect(lookups).toBe(1);
  expect(f.calls).toEqual(["use"]);
});
test("exact use still rejects its own source failure before preparing any instructions", async () => {
  for (const fromLookup of [false, true]) {
    const f = await fixture();
    const failed = { records: f.records, failures: [{ sourceId: "controlled", namespace: "controlled", type: "notion" as const, code: "ACCESS_DENIED", message: "Selected source denied" }] };
    const { tool } = await f.install(undefined, {
      getRecords: async () => fromLookup ? { records: [], failures: [] } : failed,
      lookupReference: async () => failed,
    });
    await expect(tool.execute("denied", { ref: f.root.ref }, undefined, undefined, f.ctx)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(f.calls).toEqual([]);
  }
});
test("native metadata search stays known; explicit inspect and use deliver complete bodies with separate intent", async () => {
  const f = await fixture(), { search, tool } = await f.install();
  const directory = await search.execute("search", { query: "member" }, undefined, undefined, f.ctx);
  const metadata = JSON.parse(String(directory.content[0]?.type === "text" ? directory.content[0].text : ""));
  expect(metadata.state).toBe("known"); expect(metadata.records[0].ref).toBe(f.member.ref);
  expect(JSON.stringify(metadata)).not.toContain("Exact member"); expect(f.calls).toEqual([]);
  const inspected = await nativeRead(f, f.root.ref!, "inspect");
  expect(sourceMessageText(inspected.content).startsWith(f.root.body!)).toBe(true);
  expect(sourceMessageText(inspected.content)).not.toContain(f.required.body!);
  expect(sourceMessageText(inspected.content)).toBe(f.root.body);
  const used = await tool.execute("use", { ref: f.root.ref }, undefined, undefined, f.ctx);
  const usage = JSON.parse(String(used.content[0]?.type === "text" ? used.content[0].text : ""));
  expect(usage.records.map((record: { name: string }) => record.name)).toEqual([f.root.name, f.required.name]);
  expect(usage.roots).toEqual([f.root.preparationBinding!.ref]);
  expect(preparationDetails(used)).toMatchObject({ version: 2, records: [
    { binding: { record: { id: f.root.id } } }, { binding: { record: { id: f.required.id } } },
  ] });
  expect(usage.graphs).toBeUndefined();
  expect(usage.records[0].body_sha256).toBeUndefined();
  expect(usage.records[0].snapshot_id).toBeUndefined();
  expect(f.calls).toEqual(["inspect", "use"]);
  expect(sourceBodyLoaded([], f.root)).toBe(false);
  const result = { role: "toolResult", toolName: "notion_use", toolCallId: "use", content: used.content, details: used.details, isError: false };
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
  const one = tool.execute("one", { ref: f.root.ref }, first.signal, undefined, f.ctx).then(() => "ready", () => "cancelled");
  const two = tool.execute("two", { ref: f.root.ref }, second.signal, undefined, f.ctx);
  await started.promise; first.abort();
  expect(observed[0]?.aborted).toBe(true); expect(observed[1]?.aborted).toBe(false);
  pending.resolve();
  expect(await one).toBe("cancelled");
  expect((await two).isError).not.toBe(true);
});

test("failed exact-file validation and output budget do not commit an explicit refreshed selection", async () => {
  const f = await fixture(), { tool } = await f.install();
  await expect(tool.execute("invalid", { ref: f.root.ref + "?file_id=foreign", refresh: true }, undefined, undefined, f.ctx)).rejects.toThrow();
  expect(f.persisted).toEqual([]);
  const g = await fixture(), tiny = await g.install(async purpose => [{ ...g.graph(purpose), budget: { ...g.graph(purpose).budget, maxContextBytes: 1 } }]);
  await expect(tiny.tool.execute("budget", { ref: g.root.ref, refresh: true }, undefined, undefined, g.ctx)).rejects.toThrow("PREPARE_CONTEXT_BUDGET");
  expect(g.persisted).toEqual([]);
  await tool.execute("ready", { ref: f.root.ref, refresh: true }, undefined, undefined, f.ctx);
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
  expect(await f.emit("input", { source: "rpc", text: "$root task" }, old)).toEqual([{ action: "continue" }]);
  await f.emit("before_agent_start", { prompt: "$root task", systemPrompt: "base" }, old);
  await f.emit("agent_start", {}, old);
  const preparation = f.emit("context", { messages: [{ role: "user", content: "$root task" }] }, old);
  const cancelled = preparation.then(() => undefined, error => error);
  await started.promise;
  await f.emit("session_before_switch", { type: "session_before_switch" }, old);
  revoked = true;
  const next = { ...f.ctx, sessionManager: { getSessionId: () => "next" } };
  await f.emit("session_switch", { type: "session_switch" }, next);
  expect(sourceSignal?.aborted).toBe(true);
  pending.resolve();
  expect(await cancelled).toMatchObject({ code: "SOURCE_ACTIVATION_CANCELLED" });
  expect(staleReads).toBe(0);
  expect(f.persisted).toEqual([]);
  expect(await f.emit("input", { source: "rpc", text: "$root retry" }, next)).toEqual([{ action: "continue" }]);
  await f.emit("before_agent_start", { prompt: "$root retry", systemPrompt: "base" }, next);
  await f.emit("agent_start", {}, next);
  await f.emit("context", { messages: [{ role: "user", content: "$root retry" }] }, next);
  expect(f.persisted).toEqual([], "Acquired candidates are not committed before an accepted provider request");
  await f.emit("before_provider_request", { type: "before_provider_request", payload: {} }, next);
  await f.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, next);
  expect(f.persisted).toEqual(["extend"]);
});

test("repeated native prepare bodies deduplicate only the provider projection and keep following receipt offsets valid", async () => {
  const f = await fixture(), { tool } = await f.install();
  const used = await tool.execute("first", { ref: f.root.ref }, undefined, undefined, f.ctx);
  const first = { role: "toolResult", toolName: "notion_use", toolCallId: "first", content: used.content, details: used.details, isError: false };
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

async function nativeRead(f: Awaited<ReturnType<typeof fixture>>, reference: string, toolCallId: string): Promise<AgentMessage> {
  const input = { path: reference };
  const admission = await f.emit("tool_call", { toolName: "read", toolCallId, input }, f.ctx);
  expect(admission.some(value => value && typeof value === "object" && "block" in value)).toBe(false);
  const content = [{ type: "text" as const, text: await readFile(input.path, "utf8") }];
  const outputs = await f.emit("tool_result", { toolName: "read", toolCallId, input, content, isError: false }, f.ctx);
  const annotated = outputs.find((value): value is { content?: MessageContent; details: unknown } => Boolean(value) && typeof value === "object" && value !== null && "details" in value);
  if (!annotated) throw new Error("Expected the real read hook to return a complete-body receipt");
  return { role: "toolResult", toolName: "read", toolCallId, content: annotated.content ?? content, details: annotated.details, isError: false };
}

test("short-ref directory projection preserves older pins, non-main references and canonical graph locks", async () => {
  const f = await fixture(true), oldPin = "s_" + hash("older root version");
  const relation = (name: string, ref: string) => ({ id: f.root.id!, ref, kind: "skill", name, description: name, availability: "available" });
  const main = f.root.preparationBinding!.ref, resource = f.root.entryManifest!.files.find(file => file.path !== "SKILL.md")!.ref;
  const unchanged = [
    relation("old-pin", f.root.ref + "?snapshot=" + oldPin),
    relation("unfixed-resource", f.root.ref!.replace("SKILL.md", "resources/guide.md")),
    relation("unfixed-file-id", f.root.ref + "?file_id=main-root"),
    relation("other-selector", f.member.ref!),
  ];
  f.root.preparationDirectory!.references = [...unchanged, relation("fixed-main", main), relation("fixed-resource", resource)];
  f.root.preparationDirectory!.required = [{ id: f.required.id!, ref: f.required.preparationBinding!.ref, kind: "skill",
    name: f.required.name, description: f.required.description, availability: "available" }];
  const originalDirectory = JSON.stringify(f.root.preparationDirectory), originalLock = JSON.stringify(f.graph("use").lock);
  const { tool } = await f.install();
  const result = await tool.execute("relations", { ref: f.root.ref }, undefined, undefined, f.ctx);
  const output = JSON.parse(sourceMessageText(result.content)), root = output.records.find((item: { name: string }) => item.name === f.root.name);
  for (const item of unchanged) expect(root.directory.references.find((value: { name: string }) => value.name === item.name).ref).toBe(item.ref);
  expect(root.directory.references.find((item: { name: string }) => item.name === "fixed-main").ref).toBe(root.ref);
  expect(root.directory.references.find((item: { name: string }) => item.name === "fixed-resource").ref).toMatch(/^sr:R[A-Za-z0-9_-]{22}$/);
  expect(root.directory.required[0].ref).toBe(output.records.find((item: { name: string }) => item.name === f.required.name).ref);
  expect(root.directory.candidates[0].ref).toMatch(/^sr:C[A-Za-z0-9_-]{22}$/);
  expect(JSON.stringify(f.root.preparationDirectory)).toBe(originalDirectory);
  const details = preparationDetails(result);
  expect(details.graphs).toMatchObject([{ graph_lock: JSON.parse(originalLock) }]);
  expect(JSON.stringify(details.graphs)).not.toContain("sr:");
  expect(details.records).toEqual(expect.arrayContaining([expect.objectContaining({ directory: JSON.parse(originalDirectory) })]));
  expect(output.graphs).toBeUndefined();
  expect(root.directory.files.every((file: object) => !Object.hasOwn(file, "sha256"))).toBe(true);
  expect(root.directory.references.every((reference: object) => !Object.hasOwn(reference, "id"))).toBe(true);
  expect(f.resourceReads).toEqual([]);
});

test("registered search to prepare to native read keeps one scope/version and exports fixed canonical resources", async () => {
  const f = await fixture(true, true), { search, tool, graphTool, host } = await f.install();
  expect(await realpath(f.root.path)).not.toBe(f.root.path);
  const known = JSON.parse(sourceMessageText((await search.execute("search-root", { query: "root" }, undefined, undefined, f.ctx)).content));
  const candidate = known.records[0].ref;
  expect(candidate).toMatch(/^sr:C[A-Za-z0-9_-]{22}$/);
  expect(known.state).toBe("known"); expect(f.calls).toEqual([]); expect(f.resourceReads).toEqual([]);
  expect(JSON.stringify(known)).not.toContain(f.root.body!);
  const preparedResult = await tool.execute("short-prepare", { ref: candidate }, undefined, undefined, f.ctx);
  const prepared = JSON.parse(sourceMessageText(preparedResult.content)), main = prepared.records[0].ref;
  const file = prepared.records[0].directory.files.find((item: { path: string }) => item.path === "resources/guide.md");
  expect(main).toMatch(/^sr:S[A-Za-z0-9_-]{22}$/); expect(file.ref).toMatch(/^sr:R[A-Za-z0-9_-]{22}$/);
  expect(prepared.records[0].content).toBe(f.root.body);
  expect(prepared.records[0].path).toBeUndefined();
  expect(JSON.stringify(prepared)).not.toContain(f.ctx.cwd!);
  const injected = buildInjectedContextMessage(f.root, "root", {}, {
    sourceReference: record => host.selectedModelReference(record, f.ctx),
    sourceFiles: record => host.selectedModelFiles(record, f.ctx),
  });
  const wrapper = sourceMessageText(injected.content), advertised = wrapper.match(/<resources>([^<]+)<\/resources>/)?.[1];
  expect(advertised).toBeDefined();
  const injectedFiles = JSON.parse(advertised!);
  expect(injectedFiles).toEqual([{ path: file.path, ref: file.ref }]);
  expect(wrapper).not.toContain(f.ctx.cwd!);
  expect(wrapper).not.toContain("<skill-directory>");
  expect(sourceBodyLoaded([injected], f.root)).toBe(true);
  expect(prepared.records[0].materialization).toBeUndefined();
  expect(preparationDetails(preparedResult).records).toEqual(expect.arrayContaining([expect.objectContaining({ materialization: expect.objectContaining({ local_files_ready: false, materialized_paths: ["SKILL.md"], loaded: false }) })]));
  const memberSearch = JSON.parse(sourceMessageText((await search.execute("search-member", { query: "member" }, undefined, undefined, f.ctx)).content));
  expect(memberSearch.records[0].ref).toBe(prepared.records[0].directory.candidates[0].ref);
  const entries = f.session.entries.length;
  const repeated = JSON.parse(sourceMessageText((await search.execute("repeat-root", { query: "root" }, undefined, undefined, f.ctx)).content));
  expect(repeated.records[0].ref).toBe(candidate); expect(f.session.entries).toHaveLength(entries);

  const canonicalMain = await nativeRead(f, f.root.preparationBinding!.ref, "canonical-main");
  const shortMain = await nativeRead(f, main, "short-main");
  expect(sourceMessageText(shortMain.content)).toBe(sourceMessageText(canonicalMain.content));
  expect(sourceMessageText(shortMain.content).slice(0, f.root.body!.length)).toBe(f.root.body);
  expect(sourceMessageText(shortMain.content)).toContain(main);
  expect(sourceMessageText(shortMain.content)).toContain(file.ref);
  expect(sourceMessageText(shortMain.content)).not.toContain(f.ctx.cwd!);
  expect(shortMain.details).toMatchObject({ contextBrokerRead: { version: 3, toolCallId: "short-main", snapshotId: f.root.snapshotId,
    bodySha256: f.root.preparationBinding!.body_sha256, bytes: Buffer.byteLength(f.root.body!), delivery: { start: 0, end: f.root.body!.length, encoding: "raw" } } });
  expect(sourceBodyLoaded([shortMain], f.root)).toBe(true);
  expect(sourceBodyLoaded([{ ...shortMain, content: "missing source prefix" }], f.root)).toBe(false);
  expect(sessionSourceBindings([shortMain], scope).map(binding => binding.snapshot_id)).toEqual([f.root.snapshotId!]);

  const canonicalFile = f.root.entryManifest!.files.find(item => item.path === file.path)!.ref;
  const canonicalResource = await nativeRead(f, canonicalFile, "canonical-resource"), shortResource = await nativeRead(f, injectedFiles[0].ref, "short-resource");
  expect(sourceMessageText(shortResource.content)).toBe(sourceMessageText(canonicalResource.content));
  expect(sourceMessageText(shortResource.content)).toBe(f.resourceText.get(f.root.id!));
  expect(shortResource.details).toMatchObject({ contextBrokerResource: { ref: canonicalFile, scope, snapshot_id: f.root.snapshotId,
    file_id: "guide-root", delivered_complete_text: true, loaded: false } });
  expect(sourceBodyLoaded([shortResource], f.root)).toBe(false);
  expect(f.resourceReads).toEqual([canonicalFile, canonicalFile]);

  if (!graphTool) throw new Error("Expected the deferred notion_ctl export tool");
  const legacyGraph = JSON.parse(sourceMessageText((await graphTool.execute("legacy-graph", {}, undefined, undefined, f.ctx)).content));
  expect(legacyGraph).toEqual({ kind: "controlled-selected-graph", scope });
  const exported = JSON.parse(sourceMessageText((await graphTool.execute("fixed-graph", { refs: [main, file.ref] }, undefined, undefined, f.ctx)).content));
  expect(exported.graph).toEqual(legacyGraph);
  expect(exported.references.map((item: { ref: string }) => item.ref)).toEqual([f.root.preparationBinding!.ref, canonicalFile]);
  expect(JSON.stringify(exported.references)).not.toContain("sr:");
  expect(exported.references[1]).toMatchObject({ owner: { identity: { scope, locator: f.root.locator }, snapshot_id: f.root.snapshotId, version_id: f.root.versionId }, file: { file_id: "guide-root" } });
  await expect(graphTool.execute("candidate-export", { refs: [candidate] }, undefined, undefined, f.ctx)).rejects.toMatchObject({ code: "SHORT_REF_NOT_PINNED" });
});

test("OMP keeps its version-one complete preparation output and machine receipt", async () => {
  const f = await fixture(true, false, "omp"), { tool } = await f.install();
  const result = await tool.execute("omp-use", { roots: [f.root.ref], purpose: "use" }, undefined, undefined, f.ctx);
  const output = JSON.parse(sourceMessageText(result.content)), details = preparationDetails(result);
  expect(output.records.map((record: { id: string }) => record.id)).toEqual([f.root.id, f.required.id]);
  expect(output.records[0].ref).toBe(f.root.preparationBinding!.ref);
  expect(output.records[0].scope).toBe(scope);
  expect(output.records[0].snapshot_id).toBe(f.root.snapshotId);
  expect(output.records[0].body_sha256).toBe(f.root.preparationBinding!.body_sha256);
  expect(output.records[0].content).toBe(f.root.body);
  expect(output.records[0].directory).toEqual(f.root.preparationDirectory);
  expect(output.records[0].materialization).toMatchObject({ local_files_ready: false, materialized_paths: ["SKILL.md"], loaded: false });
  expect(output.graphs[0].graph_lock).toEqual(f.graph("use").lock);
  expect(details.version).toBe(1);
  expect(details.projection).toBeUndefined();
  expect(details.graphs).toEqual(output.graphs);
  const message: AgentMessage = { role: "toolResult", toolName: "skill_prepare", toolCallId: "omp-use", content: result.content, details: result.details, isError: false };
  expect(sourceBodyLoaded([message], f.root)).toBe(true);
  expect(sourceBodyLoaded([message], f.required)).toBe(true);
});

test("short-ref tool admission cannot turn a saved locator into authority or a different scope", async () => {
  const f = await fixture(true);
  let revoked = false;
  const { search, tool } = await f.install(async purpose => {
    if (revoked) throw Object.assign(new Error("Controlled source permission denied"), { code: "SOURCE_PERMISSION_DENIED" });
    return [f.graph(purpose)];
  });
  const candidate = JSON.parse(sourceMessageText((await search.execute("known", { query: "root" }, undefined, undefined, f.ctx)).content)).records[0].ref;
  const prepared = JSON.parse(sourceMessageText((await tool.execute("selected", { ref: candidate }, undefined, undefined, f.ctx)).content));
  const fixed = prepared.records[0].ref, calls = f.calls.length;
  revoked = true;
  const deniedInput = { path: fixed }, denied = await f.emit("tool_call", { toolName: "read", toolCallId: "revoked", input: deniedInput }, f.ctx);
  expect(denied).toContainEqual(expect.objectContaining({ block: true, reason: expect.stringMatching(/SOURCE_PERMISSION_DENIED/) }));
  expect(deniedInput.path).toBe(fixed); expect(f.calls).toHaveLength(calls + 1);
  revoked = false;
  const forgedBranch = JSON.parse(JSON.stringify(f.session.entries));
  forgedBranch.find((entry: { data?: { ref?: string } }) => entry.data?.ref === candidate).data.target.identity.scope = "b".repeat(64);
  f.session.entries = forgedBranch;
  const before = f.calls.length, wrongScopeInput = { path: candidate };
  expect(await f.emit("tool_call", { toolName: "read", toolCallId: "scope", input: wrongScopeInput }, f.ctx))
    .toContainEqual(expect.objectContaining({ block: true }));
  expect(wrongScopeInput.path).toBe(candidate); expect(f.calls).toHaveLength(before);
  for (const path of ["sr:S3", "sr:S" + "A".repeat(22)]) {
    const input = { path };
    expect(await f.emit("tool_call", { toolName: "read", toolCallId: "unknown", input }, f.ctx)).toContainEqual(expect.objectContaining({ block: true }));
    expect(input.path).toBe(path);
  }
  const resource = prepared.records[0].directory.files.find((item: { path: string }) => item.path !== "SKILL.md").ref;
  await expect(tool.execute("resource-root", { ref: resource }, undefined, undefined, f.ctx)).rejects.toThrow("PREPARE_ROOT_NOT_MAIN");
  await expect(tool.execute("refresh-fixed", { ref: fixed, refresh: true }, undefined, undefined, f.ctx)).rejects.toThrow("PREPARE_VERSION_CONFLICT");
});
