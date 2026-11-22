import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { createSessionShortRefHost } from "../src/session-short-ref-host";
import { parseNativeReference } from "../src/native-reference";
import { recordIdentity } from "../src/discovery-records";
import { sessionSourceBindings, sessionSourceSnapshot, sourceMessageText, projectSelectedSourceMessages, contextSourceIdentities } from "../src/session-source-snapshot";
import { DEFAULT_RESOURCE_READ_BUDGET, type FixedResourceRead } from "../src/resource-read-types";
import type { PreparationBinding, PreparedHostGraph } from "../src/prepare-protocol";
import { SourceError } from "../src/notion-source";
import { noConsumptionWrites } from "../src/consumption-effects";
import type { ActivePreparation } from "../src/skill-preparation";
import type { AgentMessage, ContentRecord, ExtensionAPI, ExtensionContext, NativeReadResult, PiReadDefinition, SessionEntry, SkillRecord, SourceFailure } from "../src/types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
async function fixture(protectMain = true, withSessionBinding = false, currentInspection = false, outsideCatalog = false) {
  const root = await mkdtemp(join(tmpdir(), "broker-scalar-resource-host-"));
  const id = "shared_skill:scalar:owner", scope = hash("scope"), snapshot = "s_" + hash("snapshot"), version = hash("version");
  const base = "skill://" + encodeURIComponent(id) + "/";
  const ref = (path: string, file?: string) => base + path + "?snapshot=" + snapshot + (file ? "&file_id=" + file : "");
  const content: ContentRecord = { id, kind: "skill", name: "Owner", alias: "owner", description: "Scalar resource owner", default_context: false, enabled: true,
    entrypoint: "SKILL.md", ref: base + "SKILL.md", locator: { type: "shared_skill", library_id: "scalar", skill_id: "owner",
      page_id: "00000000-0000-4000-8000-000000000001", database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" } };
  const metadata: SkillRecord = { ...content, source: "notion", sourceId: "notion", sourceScope: scope, path: join(root, "metadata/SKILL.md"),
    aliases: [], normalizedAliases: [], normalizedName: "owner", normalizedDescription: content.description, autoloadEnabled: false, defaultDiscovery: false };
  const body = "Unrequested main instructions.\n", text = "\ufefffirst\r\nsecond 雪\r\n", binary = Buffer.from([0, 255, 1, 254]);
  const entryRoot = join(root, "entry");
  await mkdir(join(root, "metadata")); await mkdir(join(entryRoot, "references"), { recursive: true }); await mkdir(join(entryRoot, "assets"));
  await writeFile(metadata.path, "Owner metadata only"); await writeFile(join(entryRoot, "SKILL.md"), body);
  const files = [
    { path: "references/guide.md", file_id: "guide", data: text },
    { path: "references/empty.md", file_id: "empty", data: "" },
    { path: "assets/image.png", file_id: "image", data: binary },
  ].map(file => ({ ...file, ref: ref(file.path, file.file_id), output: join(entryRoot, file.path), bytes: Buffer.byteLength(file.data), sha256: hash(file.data) }));
  for (const file of files) await writeFile(file.output, file.data);
  const ownerBinding = { record: content, scope, snapshot_id: snapshot, version_id: version, body_sha256: hash(body), ref: ref("SKILL.md", "main") };
  const manifestFiles = [{ path: "SKILL.md", bytes: Buffer.byteLength(body), sha256: hash(body), ref: ownerBinding.ref }, ...files];
  const selected: SkillRecord = { ...metadata, body, path: join(entryRoot, "SKILL.md"), snapshotId: snapshot, versionId: version, preparationBinding: ownerBinding,
    preparationDirectory: { files: manifestFiles, required: [], candidates: [], references: [] },
    fileBindings: [{ path: "SKILL.md", file_id: "main", page_id: "00000000-0000-4000-8000-000000000001" },
      ...files.map((file, index) => ({ path: file.path, file_id: file.file_id, page_id: "00000000-0000-4000-8000-" + String(index + 2).padStart(12, "0") }))],
    entryManifest: { version: 1, root: entryRoot, receipt: join(root, "manifest"), manifest_id: hash("fixture"), files: manifestFiles,
      manifest_complete: true, local_files_ready: true, materialized_paths: manifestFiles.map(file => file.path) } };
  const state = {
    id: "session-one", file: join(root, "session-one.jsonl"), entries: [] as SessionEntry[], messages: [] as AgentMessage[], failures: [] as SourceFailure[],
    calls: [] as string[], nativeInputs: [] as Record<string, unknown>[], mainReads: 0, graphReads: 0, resourceReads: 0, persisted: 0,
    snapshot: undefined as string | undefined, unsupported: false, transform: (value: FixedResourceRead): FixedResourceRead => value,
    binding: undefined as PreparationBinding | undefined, snapshotReads: 0, bindingReads: 0, loaded: false, entry: undefined as ActivePreparation | undefined,
    wait: undefined as undefined | (() => Promise<void>), nativeWait: undefined as undefined | (() => Promise<void>),
    signal: undefined as AbortSignal | undefined, nativeResult: undefined as NativeReadResult | undefined,
    resourceFailure: undefined as Error | undefined, batchCalls: [] as string[][],
  };
  const events = new Map<string, Array<(event: never, context: ExtensionContext) => unknown>>();
  const tools = new Map<string, { definition: PiReadDefinition; source: string }>();
  const native: PiReadDefinition = { name: "read", label: "read", description: "Native scalar reader", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute(_id, input) {
      state.nativeInputs.push(input); await state.nativeWait?.();
      return state.nativeResult ?? { content: [{ type: "text", text: await readFile(input.path as string, "utf8") }], details: { native: true } };
    } };
  tools.set("read", { definition: native, source: "builtin" });
  const api: ExtensionAPI = {
    on(name, handler) { events.set(name, [...events.get(name) ?? [], handler]); },
    registerTool(tool) { tools.set(tool.name, { definition: tool as PiReadDefinition, source: "local" }); },
    getAllTools: () => [...tools.values()].map(({ definition, source }) => ({ ...definition, sourceInfo: { source, path: "/fixture" } })),
    getActiveTools: () => ["read"], appendEntry(customType, data) { state.entries.push({ type: "custom", customType, data }); },
  };
  const ctx: ExtensionContext = { cwd: root, hasUI: false, mode: "rpc", sessionManager: {
    getSessionId: () => state.id, getSessionFile: () => state.file, getBranch: () => state.entries,
    buildSessionContext: () => ({ messages: state.messages }),
  } };
  const host = await installHostSkills(api, {
    config: { sources: [{ id: "notion", type: "notion", prefetch: false }] }, getRecords: async () => ({ records: outsideCatalog ? [] : [metadata], failures: state.failures }),
    ...(outsideCatalog ? { lookupReference: async () => ({ records: [metadata], failures: [] }) } : {}),
    sessionSnapshot: () => { state.snapshotReads++; return state.snapshot; },
    ...(withSessionBinding ? { sessionBinding: () => { state.bindingReads++; return state.binding; } } : {}),
    isLoaded: () => state.loaded, onPreparation: entry => { state.entry = entry; },
    loadRecord: async () => { state.mainReads++; if (protectMain) throw new Error("Resource reads cannot load the main"); return selected; },
    resolveCurrentRoot: async () => ({ record: metadata, ref: metadata.ref! }),
    ...(protectMain ? { prepareGraph: async (_records, _ctx, _signal, purpose): Promise<PreparedHostGraph[]> => {
      state.graphReads++;
      if (!currentInspection || purpose !== "inspect") throw new Error("Resource reads cannot prepare a graph");
      const vector = { version: 1 as const, kind: "observed_version_vector" as const, purpose, scope, roots: [id], required: [], bindings: [ownerBinding] };
      return [{ purpose, scope, sourceId: "notion", roots: [id], records: [selected], bindings: [ownerBinding],
        lock: { ...vector, sha256: hash(canonical(vector)) },
        budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
        usage: { prepared_nodes: 1, instruction_bytes: Buffer.byteLength(body), context_bytes: Buffer.byteLength(body), max_depth: 0 } }];
    } } : {}),
    loadResource: async (_record, path) => { state.resourceReads++; return files.find(file => file.path === path)!.output; },
    persistGraphs: () => { state.persisted++; },
    readFixedResource: async (_record, requested_ref, _ctx, signal) => {
      state.calls.push(requested_ref); state.signal = signal; await state.wait?.();
      if (state.resourceFailure) throw state.resourceFailure;
      const parsed = parseNativeReference(requested_ref);
      if (state.unsupported || parsed.fileId === "main" || parsed.fileId === undefined && parsed.path === "SKILL.md") return undefined;
      const file = files.find(file => parsed.fileId === undefined ? file.path === parsed.path : file.file_id === parsed.fileId);
      if (!file) throw new Error("Unexpected fixture resource");
      return state.transform({ selection: { scope, owner: id, snapshot_id: snapshot, version_id: version }, ownerBinding, entrypoint: content.entrypoint,
        file: { requested_ref, ref: file.ref, path: file.path, file_id: file.file_id, bytes: file.bytes, sha256: file.sha256, output: file.output } });
    },
    readResources: async (_record, refs) => {
      state.batchCalls.push([...refs]);
      if (state.resourceFailure) throw state.resourceFailure;
      return { selection: { scope, owner: id, snapshot_id: snapshot, version_id: version }, ownerBinding,
        manifest: {}, manifest_sha256: hash("controlled resource manifest"), budget: DEFAULT_RESOURCE_READ_BUDGET, machine: {}, effects: noConsumptionWrites(),
        files: refs.map(requested_ref => {
          const parsed = parseNativeReference(requested_ref), file = files.find(file => parsed.fileId ? parsed.fileId === file.file_id : parsed.path === file.path);
          if (!file) throw new Error("Unexpected fixture resource");
          const identity = { requested_ref, ref: file.ref, path: file.path, file_id: file.file_id, bytes: file.bytes, sha256: file.sha256 };
          return typeof file.data === "string" ? { ...identity, encoding: "utf8" as const, content: file.data }
            : { ...identity, encoding: "base64" as const, content: file.data.toString("base64"), output: file.output };
        }) };
    },
  }, createPiHostAdapter(api, async () => () => native));
  const emit = async (name: string, event: Record<string, unknown> = { type: name }) => {
    const results: unknown[] = [];
    for (const handler of events.get(name) ?? []) results.push(await handler(event as never, ctx));
    return results;
  };
  const finish = async (toolCallId: string, input: Record<string, unknown>, result: NativeReadResult, flags: { isError?: boolean; parentToolCallId?: string } = {}) => {
    let merged = result;
    for (const handler of events.get("tool_result") ?? []) {
      const update = await handler({ toolName: "read", toolCallId, input, ...merged, ...flags } as never, ctx);
      if (update && typeof update === "object") merged = { ...merged, ...update };
    }
    return merged;
  };
  await emit("session_start"); await host.refresh(ctx);
  return { root, ref, files, body, text, metadata, selected, ctx, state, emit, host, finish, short: createSessionShortRefHost(api),
    read: (input: Record<string, unknown>, signal?: AbortSignal, toolCallId = "scalar-call") => tools.get("read")!.definition.execute(toolCallId, input, signal, undefined, ctx) };
}

test("a current main inspection permits only its returned fixed resources while the task keeps its old pin", async () => {
  const f = await fixture(true, true, true);
  const old = "s_" + hash("old task snapshot");
  f.state.snapshot = old;
  f.state.binding = { ...f.selected.preparationBinding!, snapshot_id: old, ref: f.selected.preparationBinding!.ref.replace(f.selected.snapshotId!, old) };
  await expect(f.read({ path: f.files[0]!.ref })).rejects.toThrow("SOURCE_SESSION_CONFLICT");
  const input = { path: f.metadata.ref!, refresh: true };
  const main = await f.finish("inspect-b", input, await f.read(input, undefined, "inspect-b"));
  const mainMessage: AgentMessage = { role: "toolResult", toolName: "read", toolCallId: "inspect-b", ...main };
  f.state.messages.push(mainMessage);
  const directory = JSON.parse(sourceMessageText(main.content).split("<skill-directory>\n")[1]!.split("\n</skill-directory>")[0]!);
  const resource = directory.directory.files.find((file: { path: string }) => file.path === "references/guide.md").ref;
  const acquired = f.state.calls.length;
  for (const path of [f.files[0]!.ref.replace(f.selected.snapshotId!, "s_" + hash("uninspected C")), f.ref("references/unlisted.md")])
    await expect(f.read({ path })).rejects.toThrow("SOURCE_SESSION_CONFLICT");
  expect(f.state.calls).toHaveLength(acquired);
  f.state.transform = value => ({ ...value, ownerBinding: { ...value.ownerBinding, record: { ...value.ownerBinding.record,
    locator: { ...value.ownerBinding.record.locator, page_id: "00000000-0000-4000-8000-000000009999" } as typeof value.ownerBinding.record.locator } } });
  await expect(f.read({ path: resource })).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
  f.state.transform = value => ({ ...value, file: { ...value.file, sha256: hash("changed file proof") } });
  await expect(f.read({ path: f.files[0]!.ref })).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
  f.state.transform = value => value;
  // The fixture returns B: an explicit A resource must reject it rather than
  // silently upgrading the task's fixed resource to the inspected version.
  await expect(f.read({ path: f.files[0]!.ref.replace(f.selected.snapshotId!, old) })).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
  const read = await f.finish("inspect-resource-b", { path: resource }, await f.read({ path: resource }, undefined, "inspect-resource-b"));
  expect(sourceMessageText(read.content)).toContain(f.text);
  expect(read.details).toMatchObject({ contextBrokerResource: { purpose: "inspect", snapshot_id: f.selected.snapshotId, loaded: false } });
  expect(f.state.snapshot).toBe(old); expect(f.state.binding.snapshot_id).toBe(old); expect(f.state.persisted).toBe(0);
  expect(f.state.graphReads).toBe(1); expect(f.state.mainReads).toBe(0);
  const resourceMessage: AgentMessage = { role: "toolResult", toolName: "read", toolCallId: "inspect-resource-b", ...read };
  expect(sessionSourceBindings([mainMessage, resourceMessage], f.metadata.sourceScope!)).toEqual([]);
  const selection = { scopes: new Map([[f.metadata.sourceScope!, { scope: f.metadata.sourceScope!, roots: new Set([f.metadata.id!]), graphs: [],
    retired: new Map(), selectionId: "old", bindings: new Map([[f.metadata.id!, f.state.binding]]) }]]) };
  expect(sourceMessageText(projectSelectedSourceMessages([resourceMessage], selection)[0]!.content)).toContain(f.text);
  expect(sourceMessageText(projectSelectedSourceMessages([resourceMessage], selection, () => "unavailable")[0]!.content)).not.toContain(f.text);
  expect(contextSourceIdentities([resourceMessage])).toEqual([{ scope: f.metadata.sourceScope, id: f.metadata.id }]);
  expect(contextSourceIdentities(projectSelectedSourceMessages([resourceMessage], selection, () => "unavailable"))).toEqual([]);
  f.state.messages = []; f.state.entries.push({ type: "message", message: mainMessage });
  expect(sourceMessageText((await f.read({ path: resource })).content)).toContain(f.text);
  f.state.entries = []; // A different branch cannot borrow the prior inspection.
  await expect(f.read({ path: f.files[0]!.ref })).rejects.toThrow("SOURCE_SESSION_CONFLICT");
  await f.emit("session_shutdown");
});

test("inspection resource batches keep exact B proofs without selecting B and retain final authorization guards", async () => {
  const f = await fixture(true, true, true), old = "s_" + hash("old task A");
  f.state.binding = { ...f.selected.preparationBinding!, snapshot_id: old, ref: f.selected.preparationBinding!.ref.replace(f.selected.snapshotId!, old) };
  const input = { path: f.metadata.ref!, refresh: true };
  const main = await f.finish("inspect-b", input, await f.read(input, undefined, "inspect-b"));
  f.state.messages.push({ role: "toolResult", toolName: "read", toolCallId: "inspect-b", ...main });
  const directory = JSON.parse(sourceMessageText(main.content).split("<skill-directory>\n")[1]!.split("\n</skill-directory>")[0]!);
  const paths = directory.directory.files.filter((file: { path: string }) => file.path.startsWith("references/")).map((file: { ref: string }) => file.ref);
  const result = await f.read({ paths }, undefined, "inspection-batch");
  const message: AgentMessage = { role: "toolResult", toolName: "read", toolCallId: "inspection-batch", ...result };
  expect(result.details).toMatchObject({ contextBrokerResource: { purpose: "inspect", loaded: false, selection: { snapshot_id: f.selected.snapshotId } } });
  expect(contextSourceIdentities([message])).toEqual([{ scope: f.metadata.sourceScope, id: f.metadata.id }]);
  expect(sessionSourceBindings([message], f.metadata.sourceScope!)).toEqual([]);
  expect(f.state.binding.snapshot_id).toBe(old); expect(f.state.persisted).toBe(0); expect(f.state.graphReads).toBe(1);
  const unavailable = projectSelectedSourceMessages([message], { scopes: new Map() }, () => "unavailable");
  expect(sourceMessageText(unavailable[0]!.content)).not.toContain(JSON.stringify(f.text).slice(1, -1));
  expect(contextSourceIdentities(unavailable)).toEqual([]);
  const calls = f.state.batchCalls.length;
  await expect(f.read({ paths: [f.files[0]!.ref.replace(f.selected.snapshotId!, "s_" + hash("uninspected C"))] })).rejects.toThrow("SOURCE_SESSION_CONFLICT");
  expect(f.state.batchCalls).toHaveLength(calls);
  const controller = new AbortController(); f.ctx.signal = controller.signal; f.ctx.abort = () => controller.abort();
  f.ctx.model = { api: "openai-completions", baseUrl: "http://127.0.0.1:8989/v1" };
  await f.emit("before_agent_start", { prompt: "Compare B resources.", systemPrompt: "Current." }); await f.emit("agent_start");
  let messages: AgentMessage[] = [{ role: "system", content: "Current." }, { role: "user", content: "Compare B resources." }, message];
  for (const event of ["context", "context_with_system"]) for (const value of await f.emit(event, { messages }))
    if (value && typeof value === "object" && "messages" in value && Array.isArray(value.messages)) messages = value.messages;
  f.state.resourceFailure = new SourceError("AUTH_REQUIRED", "notion");
  await expect(f.read({ paths })).rejects.toThrow("AUTH_REQUIRED");
  const payload = { messages: messages.map(message => ({ role: message.role === "toolResult" ? "tool" : message.role === "custom" ? "user" : message.role,
    content: sourceMessageText(message.content), ...(message.role === "toolResult" ? { tool_call_id: message.toolCallId } : {}) })) };
  await expect(f.emit("before_provider_request", { payload })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(controller.signal.aborted).toBe(true); expect(f.state.binding.snapshot_id).toBe(old);
  await f.emit("agent_end");
  const next = new AbortController(); f.ctx.signal = next.signal; f.ctx.abort = () => next.abort();
  await f.emit("before_agent_start", { prompt: "Continue without the denied content.", systemPrompt: "Current." }); await f.emit("agent_start");
  messages = [{ role: "system", content: "Current." }, { role: "user", content: "Continue without the denied content." }, message];
  for (const event of ["context", "context_with_system"]) for (const value of await f.emit(event, { messages }))
    if (value && typeof value === "object" && "messages" in value && Array.isArray(value.messages)) messages = value.messages;
  await f.emit("before_provider_request", { payload: { messages: messages.map(message => ({
    role: message.role === "toolResult" ? "tool" : message.role === "custom" ? "user" : message.role, content: sourceMessageText(message.content),
    ...(message.role === "toolResult" ? { tool_call_id: message.toolCallId } : {}),
  })) } });
  expect(next.signal.aborted).toBe(false);
  expect(messages.map(message => sourceMessageText(message.content)).join("\n")).not.toContain(JSON.stringify(f.text).slice(1, -1));
  await f.emit("session_shutdown");
});

test("an inspected owner outside the catalog remains attributable after metadata refresh and a real source denial", async () => {
  const f = await fixture(true, false, true, true);
  const input = { path: f.metadata.ref!, refresh: true };
  const main = await f.finish("outside-inspect", input, await f.read(input, undefined, "outside-inspect"));
  const message: AgentMessage = { role: "toolResult", toolName: "read", toolCallId: "outside-inspect", ...main };
  await f.host.refresh(f.ctx); // Absence alone is not a denial.
  const context = async () => {
    const result = (await f.emit("context", { messages: [message] })).find(value => value && typeof value === "object" && "messages" in value);
    if (!result || typeof result !== "object" || !("messages" in result) || !Array.isArray(result.messages)) throw new Error("Missing context projection");
    return result.messages as AgentMessage[];
  };
  expect(sourceMessageText((await context())[0]!.content)).toContain(f.body);
  f.state.failures = [{ sourceId: "notion", namespace: "notion", type: "notion", code: "AUTH_REQUIRED", message: "Controlled authoritative source denial" }];
  await f.host.refresh(f.ctx);
  expect(sourceMessageText((await context())[0]!.content)).not.toContain(f.body);
  expect(f.state.persisted).toBe(0); expect(f.state.binding).toBeUndefined();
  await f.emit("session_shutdown");
});

test("partial, failed or cancelled current main reads cannot grant cross-version resource inspection", async () => {
  for (const mode of ["partial", "failed", "cancelled"] as const) {
    const f = await fixture(true, true, true, true), old = "s_" + hash("old A");
    f.state.binding = { ...f.selected.preparationBinding!, snapshot_id: old, ref: f.selected.preparationBinding!.ref.replace(f.selected.snapshotId!, old) };
    const input = { path: f.metadata.ref!, refresh: true }, controller = new AbortController();
    let output: NativeReadResult;
    if (mode === "cancelled") {
      f.state.nativeWait = async () => { controller.abort(); };
      await expect(f.read(input, controller.signal, "incomplete-inspect")).rejects.toThrow();
      output = { content: [{ type: "text", text: f.body }] };
    } else {
      if (mode === "partial") f.state.nativeResult = { content: [{ type: "text", text: "Partial main." }] };
      output = await f.read(input, undefined, "incomplete-inspect");
    }
    const result = await f.finish("incomplete-inspect", input, output, { isError: mode === "failed" });
    expect(result.details).not.toHaveProperty("contextBrokerRead");
    f.state.messages = [{ role: "toolResult", toolName: "read", toolCallId: "incomplete-inspect", ...result }];
    await expect(f.read({ path: f.files[0]!.ref })).rejects.toThrow("SOURCE_SESSION_CONFLICT");
    expect(f.state.persisted).toBe(0); expect(f.state.binding.snapshot_id).toBe(old);
    await f.emit("session_shutdown");
  }
});

test("a fixed scalar resource delegates every native option and result without preparing or selecting its main", async () => {
  const f = await fixture(), input = { path: f.files[0]!.ref, offset: 1, limit: 2, nativeOption: "preserved" };
  const native = { content: [{ type: "text" as const, text: f.text }], details: { native: true }, nativeExtra: "preserved" };
  f.state.nativeResult = native;
  const result = await f.read(input);
  expect(result).toMatchObject(native); expect(result.content).toBe(native.content);
  expect(native.details).toEqual({ native: true });
  expect(f.state.nativeInputs).toEqual([{ ...input, path: f.files[0]!.output }]);
  expect(input.path).toBe(f.files[0]!.ref); expect(f.state.calls).toEqual([f.files[0]!.ref]);
  const delivered = await f.finish("scalar-call", input, result);
  expect(delivered.content.slice(0, native.content.length)).toEqual(native.content);
  expect(delivered.content.at(-1)).toEqual({ type: "text", text: '\n\n<notion-effects>{"version":1,"remote_writes":"unknown","author_content":"unknown"}</notion-effects>' });
  expect(delivered.details).toMatchObject({ native: true, contextBrokerResource: { version: 2, loaded: false, delivered_complete_text: true,
    delivery: { start: 0, end: f.text.length, encoding: "raw" },
    id: f.metadata.id, scope: f.metadata.sourceScope, snapshot_id: f.selected.snapshotId, file_id: "guide", sha256: hash(f.text) } });
  expect(delivered.details).toHaveProperty("contextBrokerReadDisplay", { version: 1, source: "notion", kind: "file",
    name: "Owner", sourceId: "notion", scope: f.metadata.sourceScope, files: [{ ref: input.path, path: "references/guide.md" }] });
  const messages: AgentMessage[] = [{ role: "toolResult", toolName: "read", toolCallId: "scalar-call", ...delivered }];
  expect(sessionSourceSnapshot(messages, f.metadata)).toBeUndefined(); expect(sessionSourceBindings(messages, f.metadata.sourceScope!)).toEqual([]);
  expect(f.state.mainReads + f.state.graphReads + f.state.resourceReads + f.state.persisted).toBe(0);
  expect(f.state.entries).toHaveLength(0); expect(f.metadata.body).toBeUndefined(); expect(f.metadata.entryManifest).toBeUndefined();
});

test("native partial text, empty files and images retain their content and truthful resource receipts", async () => {
  const f = await fixture();
  for (const [index, native, complete] of [
    [0, { content: [{ type: "text", text: "second 雪\r\n" }], details: { truncated: true } }, false],
    [1, { content: [{ type: "text", text: "" }] }, true],
    [2, { content: [{ type: "image", data: "AP8B/g==", mimeType: "image/png" }, { type: "text", text: "image" }] }, false],
  ] as const) {
    const input = { path: f.files[index]!.ref, offset: 2, limit: 1 };
    f.state.nativeResult = { ...native, content: [...native.content] };
    const result = await f.read(input), delivered = await f.finish("scalar-call", input, result);
    expect(result).toMatchObject(f.state.nativeResult); expect(result.content).toBe(f.state.nativeResult.content);
    expect(delivered.content.slice(0, native.content.length)).toEqual(native.content);
    expect(delivered.content.at(-1)).toEqual({ type: "text", text: '\n\n<notion-effects>{"version":1,"remote_writes":"unknown","author_content":"unknown"}</notion-effects>' });
    expect(delivered.details).toHaveProperty("contextBrokerResource.delivered_complete_text", complete);
    expect(delivered.details).toHaveProperty("contextBrokerResource.loaded", false);
  }
  expect(f.state.mainReads + f.state.graphReads).toBe(0);
});

test("stable resource File IDs resolve old hints while main hints and main aliases retain preparation", async () => {
  const f = await fixture();
  for (const path of [f.ref("old.md", "guide"), f.ref("references/guide.md")]) {
    const result = await f.read({ path });
    expect(result.content).toEqual([{ type: "text", text: f.text }]);
    expect(result.details).toHaveProperty("contextBrokerReadDisplay.files", [{ ref: path, path: "references/guide.md" }]);
    expect(f.state.nativeInputs.at(-1)?.path).toBe(f.files[0]!.output);
  }
  expect(f.state.mainReads + f.state.graphReads).toBe(0);
  const resource = await fixture(false);
  expect((await resource.read({ path: resource.ref("SKILL.md", "guide") })).content).toEqual([{ type: "text", text: resource.text }]);
  expect(resource.state.calls).toHaveLength(0); expect(resource.state.mainReads).toBe(1); expect(resource.state.resourceReads).toBe(1);
  const main = await fixture(false), input = { path: main.ref("old-resource.md", "main") };
  const result = await main.read(input), delivered = await main.finish("scalar-call", input, result);
  expect(main.state.calls).toHaveLength(1); expect(main.state.mainReads).toBe(1); expect(result.content).toEqual([{ type: "text", text: main.body }]);
  expect(delivered.details).toHaveProperty("contextBrokerRead"); expect(delivered.details).not.toHaveProperty("contextBrokerResource");
  main.metadata.name = "Renamed catalog owner"; main.selected.name = "Renamed selected owner";
  expect(JSON.parse(JSON.stringify(delivered)).details).toHaveProperty("contextBrokerReadDisplay", {
    version: 1, source: "notion", kind: "skill", name: "Owner", sourceId: "notion", scope: main.metadata.sourceScope, ref: input.path,
  });
  expect(main.state.calls).toHaveLength(1); expect(main.state.mainReads).toBe(1); expect(main.state.graphReads).toBe(0);
});

test("short scalar resources retain independent owner and file commitments without new branch bindings", async () => {
  const f = await fixture(), short = f.short.resource(f.ctx, f.selected, f.files[0]!.ref), entries = JSON.stringify(f.state.entries);
  expect((await f.read({ path: short })).content).toEqual([{ type: "text", text: f.text }]);
  expect(f.state.calls).toEqual([f.files[0]!.ref]); expect(JSON.stringify(f.state.entries)).toBe(entries);
  const mutations: Array<(value: FixedResourceRead) => FixedResourceRead> = [
    value => ({ ...value, ownerBinding: { ...value.ownerBinding, body_sha256: hash("different main") } }),
    value => ({ ...value, ownerBinding: { ...value.ownerBinding, version_id: hash("different version") } }),
    value => ({ ...value, ownerBinding: { ...value.ownerBinding, record: { ...value.ownerBinding.record, id: "foreign" } } }),
    value => ({ ...value, file: { ...value.file, sha256: hash("different resource") } }),
    value => ({ ...value, file: { ...value.file, bytes: value.file.bytes + 1 } }),
    value => ({ ...value, file: { ...value.file, file_id: "other" } }),
  ];
  for (const transform of mutations) {
    f.state.transform = transform;
    await expect(f.read({ path: short })).rejects.toThrow("SHORT_REF_OWNER_MISMATCH");
  }
  expect(f.state.nativeInputs).toHaveLength(1); expect(f.state.mainReads + f.state.graphReads).toBe(0);
});

test("foreign scalar selections fail before native read and never trigger preparation fallback", async () => {
  const f = await fixture();
  const mutations: Array<(value: FixedResourceRead) => FixedResourceRead> = [
    value => ({ ...value, selection: { ...value.selection, scope: hash("foreign") } }),
    value => ({ ...value, selection: { ...value.selection, owner: "foreign" } }),
    value => ({ ...value, selection: { ...value.selection, snapshot_id: "s_" + hash("foreign") } }),
    value => ({ ...value, file: { ...value.file, requested_ref: f.ref("other.md") } }),
    value => ({ ...value, file: { ...value.file, ref: f.ref("references/guide.md", "other") } }),
    value => ({ ...value, file: { ...value.file, output: "relative.md" } }),
  ];
  for (const transform of mutations) {
    f.state.transform = transform;
    const input = { path: f.files[0]!.ref };
    await expect(f.read(input)).rejects.toMatchObject({ details: { admission: {
      version: 1, phase: "execute", stage: "resource", code: expect.any(String), signal_aborted: false,
      generation_started: expect.any(Number), generation_current: expect.any(Number),
    } } });
    expect(input.path).toBe(f.files[0]!.ref);
  }
  expect(f.state.nativeInputs).toHaveLength(0); expect(f.state.mainReads + f.state.graphReads).toBe(0);
});

test("canonical resources retain prepared and loaded owner and file commitments without preparing again", async () => {
  for (const storage of ["prepared", "loaded"] as const) {
    const f = await fixture(storage === "prepared");
    if (storage === "prepared") {
      await f.emit("input", { source: "rpc", text: "/skill:owner" });
      expect(f.state.entry).toBeDefined(); f.state.entry!.prepared.set(recordIdentity(f.metadata), f.selected);
    } else {
      await f.host.activate(f.metadata, f.ctx); expect(f.state.mainReads).toBe(1);
      f.state.mainReads = 0; f.state.loaded = true;
    }
    const input = { path: f.ref("old-guide.md", "guide") };
    expect((await f.read(input)).content).toEqual([{ type: "text", text: f.text }]);
    const mutations: Array<(value: FixedResourceRead) => FixedResourceRead> = [
      value => ({ ...value, ownerBinding: { ...value.ownerBinding, body_sha256: hash("same pin, different owner") } }),
      value => ({ ...value, file: { ...value.file, sha256: hash("same pin, different resource") } }),
    ];
    for (const transform of mutations) {
      f.state.transform = transform; await expect(f.read(input)).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
    }
    expect(f.state.nativeInputs).toHaveLength(1); expect(f.state.mainReads + f.state.graphReads + f.state.resourceReads + f.state.persisted).toBe(0);
  }
});

test("an existing owner replaced during source or native read is rechecked even at the same pin", async () => {
  for (const phase of ["source", "native"] as const) for (const changed of ["owner", "file"] as const) {
    const f = await fixture(); await f.emit("input", { source: "rpc", text: "/skill:owner" });
    expect(f.state.entry).toBeDefined(); f.state.entry!.prepared.set(recordIdentity(f.metadata), f.selected);
    const waiting = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const wait = () => { entered.resolve(); return waiting.promise; };
    if (phase === "source") f.state.wait = wait; else f.state.nativeWait = wait;
    const pending = f.read({ path: f.files[0]!.ref }); await entered.promise;
    const replacement = changed === "owner"
      ? { ...f.selected, preparationBinding: { ...f.selected.preparationBinding!, body_sha256: hash("replaced same-pin owner") } }
      : { ...f.selected, entryManifest: { ...f.selected.entryManifest!, files: f.selected.entryManifest!.files.map(file => file.path === f.files[0]!.path
        ? { ...file, sha256: hash("replaced same-pin file") } : file) } };
    f.state.entry!.prepared.set(recordIdentity(f.metadata), replacement);
    waiting.resolve(); await expect(pending).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
    expect(f.state.nativeInputs).toHaveLength(phase === "source" ? 0 : 1);
    expect(f.state.mainReads + f.state.graphReads + f.state.persisted).toBe(0);
  }
});

test("persisted owner commitments constrain cold canonical reads and supply their pin without a second lookup", async () => {
  const f = await fixture(true, true); f.state.binding = f.selected.preparationBinding;
  f.state.snapshot = "s_" + hash("unused snapshot fallback");
  const input = { path: f.files[0]!.ref };
  expect((await f.read(input)).content).toEqual([{ type: "text", text: f.text }]);
  expect(f.state.snapshotReads).toBe(0); expect(f.state.bindingReads).toBeGreaterThan(0);
  f.state.transform = value => ({ ...value, ownerBinding: { ...value.ownerBinding, body_sha256: hash("different persisted owner") } });
  await expect(f.read(input)).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
  expect(f.state.nativeInputs).toHaveLength(1); expect(f.state.mainReads + f.state.graphReads + f.state.persisted).toBe(0);
  const legacy = await fixture(true, true); legacy.state.snapshot = "s_" + hash("legacy receipt pin");
  await expect(legacy.read({ path: legacy.files[0]!.ref })).rejects.toThrow("SOURCE_SESSION_CONFLICT");
  expect(legacy.state.snapshotReads).toBeGreaterThan(0); expect(legacy.state.calls).toHaveLength(0);
});

test("same-pin persisted owner changes during either read phase cannot deliver the old result", async () => {
  for (const phase of ["source", "native"] as const) {
    const f = await fixture(true, true); f.state.binding = f.selected.preparationBinding;
    const waiting = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const wait = () => { entered.resolve(); return waiting.promise; };
    if (phase === "source") f.state.wait = wait; else f.state.nativeWait = wait;
    const pending = f.read({ path: f.files[0]!.ref }); await entered.promise;
    f.state.binding = { ...f.selected.preparationBinding!, body_sha256: hash("new branch owner commitment") };
    waiting.resolve(); await expect(pending).rejects.toThrow("SOURCE_IDENTITY_MISMATCH");
    expect(f.state.nativeInputs).toHaveLength(phase === "source" ? 0 : 1); expect(f.state.mainReads + f.state.graphReads + f.state.persisted).toBe(0);
  }
});

test("fixed scalar reads preserve source blocking and selected session snapshot conflicts", async () => {
  const f = await fixture(); f.state.snapshot = "s_" + hash("different selected main");
  await expect(f.read({ path: f.files[0]!.ref })).rejects.toThrow("SOURCE_SESSION_CONFLICT");
  f.state.snapshot = undefined;
  f.state.failures = [{ sourceId: "notion", namespace: "notion", type: "notion", code: "SOURCE_PERMISSION_DENIED", message: "Denied" }];
  await f.host.refresh(f.ctx);
  await expect(f.read({ path: f.files[0]!.ref })).rejects.toThrow("SOURCE_PERMISSION_DENIED");
  expect(f.state.calls).toHaveLength(0); expect(f.state.nativeInputs).toHaveLength(0); expect(f.state.mainReads + f.state.graphReads).toBe(0);
});

test("unfixed, selected, candidate and ordinary paths retain their existing routes", async () => {
  for (const kind of ["unfixed", "selected", "candidate", "main", "main-file-id", "ordinary"] as const) {
    const f = await fixture(false);
    const path = kind === "unfixed" ? f.files[0]!.ref.split("?")[0]!
      : kind === "selected" ? f.short.selected(f.ctx, f.selected)
      : kind === "candidate" ? f.short.candidate(f.ctx, f.metadata)
      : kind === "main" ? f.ref("SKILL.md") : kind === "main-file-id" ? f.ref("SKILL.md", "main") : f.files[0]!.output;
    await f.read({ path });
    expect(f.state.calls).toHaveLength(0); expect(f.state.mainReads).toBe(kind === "ordinary" ? 0 : 1);
  }
  const unsupported = await fixture(false); unsupported.state.unsupported = true;
  const short = unsupported.short.resource(unsupported.ctx, unsupported.selected, unsupported.files[0]!.ref);
  expect((await unsupported.read({ path: short })).content).toEqual([{ type: "text", text: unsupported.text }]);
  expect(unsupported.state.mainReads).toBe(1); expect(unsupported.state.resourceReads).toBe(1);
});

test("source and native late results cannot escape cancellation, session changes or branch rewind", async () => {
  for (const phase of ["source", "native"] as const) for (const boundary of ["abort", "session", "file", "branch", "rewind"] as const) {
    const f = await fixture(), short = f.short.resource(f.ctx, f.selected, f.files[0]!.ref);
    const waiting = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), controller = new AbortController();
    const wait = () => { entered.resolve(); return waiting.promise; };
    if (phase === "source") f.state.wait = wait; else f.state.nativeWait = wait;
    const input = { path: short }, pending = f.read(input, controller.signal); await entered.promise;
    if (boundary === "abort") controller.abort();
    else if (boundary === "session") f.state.id = "session-two";
    else if (boundary === "file") f.state.file = join(f.root, "other.jsonl");
    else if (boundary === "branch") await f.emit("session_before_branch");
    else f.state.entries = [];
    waiting.resolve(); await expect(pending).rejects.toThrow();
    expect(f.state.nativeInputs).toHaveLength(phase === "source" ? 0 : 1);
    const delivered = await f.finish("scalar-call", input, { content: [{ type: "text", text: f.text }] });
    expect(delivered.details).toBeUndefined(); expect(f.state.mainReads + f.state.graphReads + f.state.persisted).toBe(0);
  }
});

test("a branch rewind after native return cannot attach a late resource receipt", async () => {
  const f = await fixture(), short = f.short.resource(f.ctx, f.selected, f.files[0]!.ref), input = { path: short };
  const result = await f.read(input); f.state.entries = [];
  const delivered = await f.finish("scalar-call", input, result);
  expect(delivered.details).toEqual(result.details);
  expect(delivered.details).toHaveProperty("native", true);
  expect(delivered.details).toHaveProperty("contextBrokerReadDisplay", { version: 1, source: "notion", kind: "file",
    name: "Owner", sourceId: "notion", scope: f.metadata.sourceScope, files: [{ ref: short, path: "references/guide.md" }] });
  expect(delivered.details).not.toHaveProperty("contextBrokerResource");
  const messages: AgentMessage[] = [{ role: "toolResult", toolName: "read", toolCallId: "scalar-call", ...delivered }];
  expect(sessionSourceSnapshot(messages, f.metadata)).toBeUndefined();
  expect(sessionSourceBindings(messages, f.metadata.sourceScope!)).toEqual([]);
});
