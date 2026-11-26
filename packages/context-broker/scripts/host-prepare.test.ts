import { nativeFileRef, nativeSkillId, parseNativeReference, withNativeSnapshot } from "../src/native-reference";
import { expect, test, setSystemTime, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { installHostSkills, type HostSkills, type HostSkillOptions } from "../src/host-skills";
import { SourceError, sourceFailureMessage } from "../src/notion-source";
import { ACTIVATION_MESSAGE, createActivationFeedback } from "../src/activation-feedback";
import { createLibrarySelection } from "../src/library-selection";
import { CONTENT_SEARCH_TIMEOUT_MS } from "../src/content-search";
import { buildCliGuidance, buildInjectedContextMessage, installSkillGuidance } from "../src/index";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { createOmpHostAdapter } from "../src/omp-host-adapter";
import type { HostCapabilities } from "../src/host-adapter";
import { deduplicateSourceReads, deferredSourceEntries, sourceDeliveryReceipt, sourceBodyLoaded, sourceMessageText, sessionSourceBindings, withSessionSourceReceipts } from "../src/session-source-snapshot";
import { materializeNotionEntryFile, publishNotionEntry } from "../src/notion-entry";
import { projectCatalogDescriptions } from "../src/skill-catalog-projection";
import { preparationFailureDetails, type PreparedHostGraph, type PreparationPurpose } from "../src/prepare-protocol";
import type { AgentMessage, ContentRecord, ExtensionAPI, ExtensionContext, MessageContent, NativeReadExecutor, NativeSkillGraphDefinition, NativeSkillPrepareDefinition, NativeSkillSearchDefinition, SessionEntry, SkillRecord } from "../src/types";
import { persistSessionSelection, sessionSelection, type SelectionMode } from "../src/session-graph";
import { combineConsumptionEffects, consumptionEffects, isConsumptionEffects, noConsumptionWrites, unknownConsumptionEffects, type ConsumptionEffects, type ConsumptionPolicy } from "../src/consumption-effects";
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
async function fixture(withShortRefs = false, withDirectoryAlias = false, hostKind: "pi" | "omp" = "pi", identityScope = scope, withBodyCard = false,
  owner = { libraryId: "1031b73d-3a2f-589c-9bdb-ebb50a7eb063", sourceId: "controlled" }) {
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
    const id = nativeSkillId(owner.libraryId, String(name));
    const metadata: ContentRecord = {
      id, kind: "skill", name, alias: name, description: withBodyCard && name === "member" ? 'Controlled member <metadata> & "原文".' : "Controlled " + name, enabled: true, default_context: index === 0,
      entrypoint: "SKILL.md", ref: nativeFileRef(id, "SKILL.md"),
      locator: { type: "shared_skill", library_id: owner.libraryId, skill_id: name, page_id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
        database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" },
    };
    const body = "\ufeff---\r\nname: " + name + "\r\n---\r\nExact " + name + " <instructions>.\r\n" + (owner.sourceId === "controlled" ? "" : owner.sourceId + " owner bytes.\r\n")
      + (withBodyCard && name === "root" ? '\r\n## Members\r\n\r\n- [member](skill://member/SKILL.md?library=1031b73d-3a2f-589c-9bdb-ebb50a7eb063) — Controlled member <metadata> & "原文".\r\n' : "");
    const snapshotId = "s_" + hash(name), path = join(directory, name, "SKILL.md");
    await mkdir(join(directory, name), { recursive: true });
    await writeFile(path, body);
    let selected: SkillRecord = {
      ...metadata, source: "notion", sourceId: owner.sourceId, sourceScope: identityScope, body, path, snapshotId, versionId: hash(body),
      ...(owner.sourceId === "controlled" ? {} : { token: owner.sourceId + "/" + name }),
      aliases: [], normalizedAliases: [], normalizedName: name, normalizedDescription: metadata.description, autoloadEnabled: true, defaultDiscovery: false,
      preparationBinding: { record: metadata, scope: identityScope, snapshot_id: snapshotId, version_id: hash(body), body_sha256: hash(body), ref: withNativeSnapshot(metadata.ref, snapshotId) },
      preparationDirectory: { files: [], required: [], candidates: [], references: [] },
    };
    if (withShortRefs) {
      const resource = "Exact " + name + " resource bytes.\r\n";
      resourceText.set(id, resource);
      const files = [{ path: "SKILL.md", bytes: Buffer.byteLength(body), sha256: hash(body), ref: selected.preparationBinding.ref },
        { path: "resources/guide.md", bytes: Buffer.byteLength(resource), sha256: hash(resource),
          ref: withNativeSnapshot(metadata.ref.replace("SKILL.md", "resources/guide.md"), snapshotId) }];
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
  const sources: Array<{ id: string; type: "notion"; prefetch: false; library?: string }> = [{ id: owner.sourceId, type: "notion", prefetch: false }];
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  let search: NativeSkillSearchDefinition | undefined, tool: NativeSkillPrepareDefinition | undefined, graphTool: NativeSkillGraphDefinition | undefined;
  const api: ExtensionAPI = { ...(hostKind === "omp" ? { pi: {} } : {}), on(name, listener) { events.set(name, [...events.get(name) ?? [], listener]); },
    appendEntry(customType, data) { session.entries.push({ type: "custom", customType, data }); },
    registerTool(value) { if (value.name === "skill_search" || value.name === "notion_list") search = value; if (value.name === "skill_prepare" || value.name === "notion_use") tool = value; if (value.name === "skill_graph" || value.name === "notion_ctl") graphTool = value; } };
  function graph(purpose: PreparationPurpose): PreparedHostGraph {
    const validatedAt = Date.now();
    const selected = (purpose === "use" ? [root!, required!] : [root!]).map(record => ({ ...record,
      currentObservation: { origin: "remote" as const, validatedAt, validUntil: validatedAt + 60_000 } }));
    const vector = { version: 1 as const, kind: "observed_version_vector" as const, purpose, scope: identityScope, roots: [root!.id!],
      required: purpose === "use" ? [{ from: root!.id!, to: required!.id!, ref: required!.preparationBinding!.ref }] : [],
      bindings: selected.map(record => record.preparationBinding!) };
    return { purpose, sourceId: owner.sourceId, scope: identityScope, roots: [root!.id!], records: selected, bindings: selected.map(record => record.preparationBinding!), lock: { ...vector, sha256: hash(canonical(vector)) },
      budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
      usage: { prepared_nodes: selected.length, instruction_bytes: selected.reduce((n, record) => n + Buffer.byteLength(record.body!), 0), context_bytes: 4000, max_depth: purpose === "use" ? 1 : 0 } };
  }
  const install = async (prepareGraph: (purpose: PreparationPurpose, signal: AbortSignal | undefined, policy: ConsumptionPolicy | undefined, requested: readonly SkillRecord[], pins: ReadonlyMap<string, string> | undefined) => Promise<PreparedHostGraph[]> = async purpose => [graph(purpose)], discovery: Partial<Pick<HostSkillOptions, "getRecords" | "lookupReference" | "buildPreparedPrompt" | "persistGraphs" | "resolveRelativeReference" | "resolveSkillReference" | "sessionBinding" | "librarySelection" | "restoreActive" | "confirmDelivery">> = {}, adapter?: HostCapabilities) => {
    let host: HostSkills;
    host = await installHostSkills(api, {
      config: { sources },
      getRecords: async () => ({ records: records.map(record => ({ ...record, body: undefined, preparationBinding: undefined })), failures: [] }),
      ...discovery,
      loadRecord: async () => { throw new Error("Graph roots must use the CLI preparation bridge"); },
      loadResource: async (record, path, _ctx, signal) => materializeNotionEntryFile(record, path, ensure, async (file, output) => {
        const text = resourceText.get(record.id!);
        if (text === undefined || file.path !== "resources/guide.md") throw new Error("Unexpected fixture resource");
        resourceReads.push(file.ref);
        await writeFile(output, text);
      }, signal),
      resolveCurrentRoot: async record => ({ record, ref: record.ref! }),
      prepareGraph: async (requested, _ctx, signal, purpose, pins, _bindings, _mode, policy) => { calls.push(purpose); return prepareGraph(purpose, signal, policy, requested, pins); },
      persistGraphs: discovery.persistGraphs ?? ((_graphs, _ctx, mode) => { persisted.push(mode); }),
      ...(withShortRefs ? { sessionGraph: () => ({ kind: "controlled-selected-graph", scope: identityScope }) } : {}),
      needsPreflightPrompt: text => text.includes("$root"),
      preflightPrompt: async (text, ctx, signal) => { if (text.includes("$root")) await host.prepareMany([root!], ctx, signal); },
    }, adapter ?? (hostKind === "omp" ? createOmpHostAdapter(api) : createPiHostAdapter(api)));
    if (!search || !tool) throw new Error("Expected native graph tools");
    return { search, tool, graphTool, host };
  };
  const emit = async (name: string, value: unknown, ctx: ExtensionContext) => {
    const results = [];
    for (const listener of events.get(name) ?? []) results.push(await listener(value as never, ctx));
    return results;
  };
  return { ctx, records, root: root!, required: required!, member: member!, graph, calls, persisted, install, emit, session, resourceText, resourceReads, api, sources };
}

test("Pi use and native inspect always forbid writes and reject the retired policy input", async () => {
  const f = await fixture();
  const effects = noConsumptionWrites();
  const policies: boolean[] = [];
  let requiresWrite = false;
  const { tool } = await f.install(async (purpose, _signal, policy) => {
    policies.push(policy?.readOnly === true);
    if (requiresWrite) throw new SourceError("NOTION_READ_ONLY", "controlled", undefined, { effects });
    policy?.observeEffects?.(effects);
    return [{ ...f.graph(purpose), effects }];
  });
  expect(tool.parameters).not.toHaveProperty("properties.readOnly");
  expect(tool.description).not.toMatch(/retain history|pass readOnly|versions remain/);
  const used = await tool.execute("effects-use", { ref: f.root.ref }, undefined, undefined, f.ctx);
  expect(JSON.parse(sourceMessageText(used.content)).effects).toEqual(effects);
  const inspected = await nativeRead(f, f.root.ref!, "effects-inspect");
  expect(sourceMessageText(inspected.content)).toContain("<notion-effects>" + JSON.stringify(effects) + "</notion-effects>");
  expect(sourceMessageText(inspected.content).slice(0, f.root.body!.length)).toBe(f.root.body);
  for (const readOnly of [true, false, undefined]) {
    await expect(tool.execute("retired-policy", { ref: f.root.ref, readOnly }, undefined, undefined, f.ctx))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const invalid = await f.emit("tool_call", { toolName: "read", input: { path: f.root.ref!, readOnly } }, f.ctx);
    expect(invalid).toContainEqual(expect.objectContaining({ block: true, admission: expect.objectContaining({ code: "INVALID_ARGUMENT" }) }));
  }
  expect(policies).toEqual([true, true]);
  requiresWrite = true;
  await expect(tool.execute("write-refused", { ref: f.root.ref }, undefined, undefined, f.ctx))
    .rejects.toMatchObject({ details: { effects } });
  const input = { path: f.root.ref! };
  const admission = await f.emit("tool_call", { toolName: "read", toolCallId: "strict-inspect", input }, f.ctx);
  expect(admission).toContainEqual(expect.objectContaining({ block: true }));
  expect(JSON.stringify(admission)).toContain('remote_writes\\":\\"none');
  expect(input.path).toBe(f.root.ref);
  expect(policies).toEqual([true, true, true, true]);
});

test("Pi dollar acquisition discloses its own effects in provider and native history without changing source proof", async () => {
  const f = await fixture(true);
  const observed: ConsumptionEffects = { version: 1, remote_writes: "unknown", author_content: "unchanged" };
  let effects: ConsumptionEffects = observed;
  await f.install(async purpose => [{ ...f.graph(purpose), effects }], {
    buildPreparedPrompt: async (_text, _ctx, _signal, records = []) => {
      const content = records.map(record => record.body!).join("\n\n");
      return { customType: "context-broker", content, display: false,
        details: { records: records.map(record => sourceDeliveryReceipt(record, content)) } };
    },
  });
  for (const [id, expected] of [["first", observed], ["second", noConsumptionWrites()]] as const) {
    effects = expected;
    const user: AgentMessage = { role: "user", content: "$root task " + id };
    await f.emit("input", { source: "rpc", text: user.content }, f.ctx);
    await f.emit("before_agent_start", { prompt: user.content, systemPrompt: "base" }, f.ctx);
    await f.emit("agent_start", {}, f.ctx);
    const outputs = await f.emit("context", { messages: [user] }, f.ctx);
    const output = outputs.find(value => value && typeof value === "object" && "messages" in value && Array.isArray(value.messages));
    if (!output || typeof output !== "object" || !("messages" in output) || !Array.isArray(output.messages)) throw new Error("Expected provider projection");
    const delivered: AgentMessage[] = output.messages;
    expect(sourceBodyLoaded(delivered, f.root)).toBe(true);
    expect(sourceBodyLoaded(delivered, f.required)).toBe(true);
    expect(delivered.filter(message => message.customType === "context-broker-consumption-effects"))
      .toEqual([expect.objectContaining({ content: "<notion-effects>" + JSON.stringify(expected) + "</notion-effects>", details: { effects: expected } })]);
    const persisted = deferredSourceEntries([{ sourceEntry: { id, type: "message", message: user }, messages: [user] }], id, delivered.slice(1));
    const edit = persisted?.entries[0], receipt = persisted?.entries[1];
    if (edit?.type !== "context_edit" || !edit.replacement || receipt?.type !== "custom") throw new Error("Expected native history and proof");
    expect(sourceMessageText(edit.replacement.content)).toContain("<notion-effects>" + JSON.stringify(expected) + "</notion-effects>");
    expect(sourceBodyLoaded(withSessionSourceReceipts([{ ...user, content: edit.replacement.content }],
      [{ sourceEntry: { ...receipt, id: id + "-receipt" }, messages: [] }]), f.root)).toBe(true);
    await f.emit("before_provider_request", {}, f.ctx);
    await f.emit("after_provider_response", { status: 200 }, f.ctx);
  }
});

test("accepted exact dollar graph prepares while the catalog remains pending", async () => {
  const f = await fixture(true), release = Promise.withResolvers<void>();
  let directoryReturned = false;
  await f.install(undefined, {
    getRecords: async () => { await release.promise; directoryReturned = true; return { records: f.records, failures: [] }; },
    buildPreparedPrompt: async (_text, _ctx, _signal, records = []) => {
      const content = records.map(record => record.body!).join("\n\n");
      return { customType: "context-broker", content, display: false,
        details: { records: records.map(record => sourceDeliveryReceipt(record, content)) } };
    },
  });
  const user: AgentMessage = { role: "user", content: "$root cached choice" };
  await f.emit("input", { source: "rpc", text: user.content }, f.ctx);
  await f.emit("before_agent_start", { prompt: user.content, systemPrompt: "base" }, f.ctx);
  await f.emit("agent_start", {}, f.ctx);
  const pending = f.emit("context", { messages: [user] }, f.ctx);
  try {
    const result = await Promise.race([pending, new Promise<undefined>(resolve => setTimeout(resolve, 100))]);
    expect(directoryReturned).toBe(false);
    expect(result).toBeDefined();
    const output = result!.find(value => value && typeof value === "object" && "messages" in value && Array.isArray(value.messages));
    if (!output || typeof output !== "object" || !("messages" in output) || !Array.isArray(output.messages)) throw new Error("Expected complete source projection");
    expect(sourceBodyLoaded(output.messages, f.root)).toBe(true);
    expect(sourceBodyLoaded(output.messages, f.required)).toBe(true);
    expect(output.messages).toContainEqual(user);
    expect(f.calls).toEqual(["use"]);
    expect(f.persisted).toEqual([]);
  } finally { release.resolve(); await pending; await f.emit("session_shutdown", {}, f.ctx); }
});

test("accepted exact Prompt reads through its SDK boundary before catalog completion", async () => {
  const f = await fixture(), release = Promise.withResolvers<void>();
  const record: SkillRecord = { ...f.root, kind: "prompt" };
  const reads: SkillRecord[] = [];
  const host = await installHostSkills(f.api, { config: { sources: f.sources },
    getRecords: async () => { await release.promise; return { records: [], failures: [] }; },
    loadRecord: async requested => {
      reads.push(requested);
      const validatedAt = Date.now();
      return { ...requested, body: record.body, currentObservation: { origin: "remote", validatedAt, validUntil: validatedAt + 60_000 } };
    },
  }, createPiHostAdapter(f.api));
  const pending = host.prepare(record, f.ctx);
  try {
    const result = await Promise.race([pending, new Promise<undefined>(resolve => setTimeout(resolve, 100))]);
    expect(result?.status).toBe("ready");
    expect(reads).toEqual([record]);
  } finally { release.resolve(); await pending; await f.emit("session_shutdown", {}, f.ctx); }
});

test("accepted exact records keep their physical binding and reject their own catalog denial", async () => {
  for (const denied of [false, true]) {
    const f = await fixture();
    const original = structuredClone(f.root), requested: SkillRecord[] = [];
    const replacement = { ...f.root, locator: { ...f.root.locator!, page_id: "00000000-0000-4000-8000-000000000099" } } as SkillRecord;
    const { host } = await f.install(async (purpose, _signal, _policy, records) => { requested.push(...records); return [f.graph(purpose)]; }, {
      getRecords: async () => ({ records: [replacement], failures: denied
        ? [{ sourceId: "controlled", namespace: "controlled", type: "notion", code: "ACCESS_DENIED", message: "Selected source denied" }] : [] }),
    });
    await host.refresh(f.ctx);
    if (denied) {
      await expect(host.prepareMany([original], f.ctx)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
      expect(requested).toEqual([]);
    } else {
      expect((await host.prepare(original, f.ctx)).status).toBe("ready");
      expect(requested[0]!.locator).toEqual(original.locator);
      expect(requested[0]!.locator).not.toEqual(replacement.locator);
    }
    await f.emit("session_shutdown", {}, f.ctx);
  }
});

test("partial multi-source failure retains prior effects and cannot report zero writes", async () => {
  const f = await fixture();
  const observed: ConsumptionEffects = { version: 1, remote_writes: "unknown", author_content: "unchanged" };
  const original = Object.freeze(new SourceError("NOTION_UNAVAILABLE", "second-source", 23));
  const { tool } = await f.install(async (_purpose, _signal, policy) => {
    policy?.observeEffects?.(observed);
    throw original;
  });
  const error = await tool.execute("partial-effects", { ref: f.root.ref }, undefined, undefined, f.ctx).then(() => undefined, error => error);
  expect(error).toBeInstanceOf(SourceError);
  expect(error).toMatchObject({ code: "NOTION_UNAVAILABLE", sourceId: "second-source", exitCode: 23, cause: original,
    details: { effects: { version: 1, remote_writes: "unknown", author_content: "unknown" } } });
  expect(original.details).toBeUndefined();
});

test("dollar preflight failure keeps earlier source effects and the original denial", async () => {
  const observed: ConsumptionEffects = { version: 1, remote_writes: "unknown", author_content: "unchanged" };
  for (const secondEffects of [noConsumptionWrites(), undefined]) {
    const f = await fixture(true);
    const original = Object.freeze(new SourceError("ACCESS_DENIED", "second-source", undefined,
      secondEffects ? { effects: secondEffects } : undefined));
    await f.install(async (_purpose, _signal, policy) => {
      policy?.observeEffects?.(observed);
      throw original;
    }, { buildPreparedPrompt: async () => buildInjectedContextMessage(f.root, "root") });
    const user: AgentMessage = { role: "user", content: "$root task" };
    await f.emit("input", { source: "rpc", text: user.content }, f.ctx);
    await f.emit("before_agent_start", { prompt: user.content, systemPrompt: "base" }, f.ctx);
    await f.emit("agent_start", {}, f.ctx);
    const result = await f.emit("context", { messages: [user] }, f.ctx);
    const effects = { ...observed, remote_writes: "unknown", author_content: secondEffects ? "unchanged" : "unknown" };
    expect(result).toContainEqual(expect.objectContaining({ messages: expect.arrayContaining([user,
      expect.objectContaining({ customType: "context-broker-preparation-warning",
        content: expect.stringContaining("ACCESS_DENIED"), details: { effects } })]) }));
    expect(JSON.stringify(result)).not.toContain(f.root.body!.trim());
    expect(original.details?.effects).toBe(secondEffects);
    expect(f.persisted).toEqual([]);
  }
});

test("native cancellation after preparation preserves unknown effects and admits no read", async () => {
  const f = await fixture(), controller = new AbortController();
  const observed: ConsumptionEffects = { version: 1, remote_writes: "unknown", author_content: "unchanged" };
  const adapter = createPiHostAdapter(f.api);
  let executeRead: NativeReadExecutor | undefined, nativeCalls = 0;
  adapter.registerReadExecutor = execute => { executeRead = execute; return () => true; };
  const { host } = await f.install(async (purpose, _signal, policy) => {
    policy?.observeEffects?.(observed);
    return [{ ...f.graph(purpose), effects: observed }];
  }, { persistGraphs: () => { queueMicrotask(() => controller.abort()); } }, adapter);
  await host.refresh(f.ctx);
  if (!executeRead) throw new Error("Expected the native read executor");
  const input = { path: f.root.ref }, toolCallId = "cancel-after-prepared";
  const error = await executeRead(input, f.ctx, controller.signal, async () => {
    nativeCalls++; return { content: [{ type: "text", text: f.root.body! }] };
  }, toolCallId).then(() => undefined, error => error);
  expect(controller.signal.aborted).toBe(true);
  expect(nativeCalls).toBe(0);
  expect(error).toMatchObject({ code: "SOURCE_ACTIVATION_CANCELLED", details: { effects: observed } });
  expect(JSON.parse(error.message).effects).toEqual(observed);
  const late = await f.emit("tool_result", { toolName: "read", toolCallId, input,
    content: [{ type: "text", text: f.root.body! }], isError: false }, f.ctx);
  expect(late.every(value => value === undefined)).toBe(true);
});

test("native DOMException keeps prepared effects without mutating the original error or delivering a body", async () => {
  const f = await fixture();
  const observed: ConsumptionEffects = { version: 1, remote_writes: "unknown", author_content: "unchanged" };
  const original = new DOMException("Native transport aborted", "AbortError");
  const adapter = createPiHostAdapter(f.api);
  let executeRead: NativeReadExecutor | undefined;
  adapter.registerReadExecutor = execute => { executeRead = execute; return () => true; };
  const { host } = await f.install(async purpose => [{ ...f.graph(purpose), effects: observed }], {}, adapter);
  await host.refresh(f.ctx);
  if (!executeRead) throw new Error("Expected the native read executor");
  const input = { path: f.root.ref }, toolCallId = "native-domexception";
  const error = await executeRead(input, f.ctx, undefined, async () => { throw original; }, toolCallId)
    .then(() => undefined, error => error);
  expect(error).toMatchObject({ name: "AbortError", code: original.code, cause: original, details: { effects: observed } });
  expect(JSON.parse(error.message).effects).toEqual(observed);
  expect(original.message).toBe("Native transport aborted");
  const late = await f.emit("tool_result", { toolName: "read", toolCallId, input,
    content: [{ type: "text", text: f.root.body! }], isError: false }, f.ctx);
  expect(late.every(value => value === undefined)).toBe(true);
});

function exactDenial(record: SkillRecord, code: "CONTENT_DISABLED" | "ACCESS_DENIED" | "AUTH_REQUIRED" = "CONTENT_DISABLED") {
  return new SourceError(code, record.sourceId!, undefined, preparationFailureDetails({ preparation: {
    version: 1, status: "failed", purpose: "use", scope: record.sourceScope,
    nodes: [{ state: "failed", id: record.id, ref: record.ref, roles: ["root"], error: { code } }],
    errors: [{ target: record.ref, code }],
  } }));
}

test("a live disabled read corrects stale availability without extra discovery and permits re-enable retry", async () => {
  const f = await fixture(true);
  let remoteEnabled = false, metadataRequests = 0;
  const { host, search } = await f.install(async purpose => {
    if (!remoteEnabled) throw exactDenial(f.root);
    return [f.graph(purpose)];
  }, { getRecords: async () => {
    metadataRequests++;
    return { records: f.records.map(record => ({ ...record, body: undefined, preparationBinding: undefined,
      defaultDiscovery: record === f.root })), failures: [], lists: [{ sourceId: "controlled", policy: "default", exhaustive: true }] };
  } });
  await host.refresh(f.ctx);
  const availability = async () => {
    const output = await search.execute("lookup", { query: "root" }, undefined, undefined, f.ctx);
    if (output.content[0]?.type !== "text") throw new Error("Expected metadata JSON");
    return JSON.parse(output.content[0].text).records[0]?.availability;
  };
  const catalog = async () => JSON.stringify(await f.emit("context_with_system", { messages: [
    { role: "system", content: "Native safety prompt" }, { role: "user", content: "Inspect root" },
  ] }, f.ctx));
  expect(await availability()).toBe("available");
  expect(await catalog()).toContain('name=\\"root\\"');
  const before = metadataRequests;
  await expect(host.activate(f.root, f.ctx)).rejects.toMatchObject({ code: "CONTENT_DISABLED" });
  expect(await availability()).toBe("disabled");
  expect(await catalog()).not.toContain('name=\\"root\\"');
  expect(f.root.enabled).toBe(true, "A failed live read must not turn the saved candidate into a permanently disabled record");
  expect(metadataRequests).toBe(before);
  expect(sourceFailureMessage("CONTENT_DISABLED")).toContain("Enabled=false");
  expect(sourceFailureMessage("CONTENT_DISABLED")).not.toContain("source configuration");
  const blocked = await f.emit("tool_call", { toolName: "read", toolCallId: "disabled-retry", input: { path: f.root.ref } }, f.ctx);
  expect(JSON.stringify(blocked)).toContain("context-broker Skill disabled (CONTENT_DISABLED)");
  remoteEnabled = true;
  expect((await host.activate(f.root, f.ctx)).body).toContain("Exact root");
  expect(await availability()).toBe("available");
  expect(await catalog()).toContain('name=\\"root\\"');
  expect(metadataRequests).toBe(before);
});

test("Pi projects the published default catalog after exact preparation without pinning the earlier pending observation", async () => {
  const f = await fixture(true), metadata = Promise.withResolvers<Awaited<ReturnType<HostSkillOptions["getRecords"]>>>();
  const { search } = await f.install(undefined, { getRecords: () => metadata.promise });
  const user = { role: "user", content: "$root task" };
  await f.emit("input", { source: "rpc", text: user.content }, f.ctx);
  const before = await f.emit("before_agent_start", { prompt: user.content, systemPrompt: "Native instructions" }, f.ctx);
  const beforePrompt = before.flatMap(result => result && typeof result === "object" && "systemPrompt" in result && typeof result.systemPrompt === "string"
    ? [result.systemPrompt] : []).at(-1) ?? "Native instructions";
  await f.emit("agent_start", {}, f.ctx);
  const preparing = f.emit("context", { messages: [user] }, f.ctx);
  metadata.resolve({ records: f.records.map(record => ({ ...record, body: undefined, preparationBinding: undefined,
    defaultDiscovery: record !== f.required })), failures: [] });
  await preparing;
  await search.execute("published-default", { query: "root" }, undefined, undefined, f.ctx);
  const head = { role: "system", content: beforePrompt, sections: { local: "Keep the native local rules" },
    toolsAdded: [{ name: "read", parameters: { type: "object" } }] };
  const messages = [head, user], original = JSON.stringify(messages);
  const projected = await f.emit("context_with_system", { messages }, f.ctx);
  const actual = JSON.stringify(projected.length ? projected : { messages });
  expect(actual).toContain('name=\\"root\\"');
  expect(actual).toContain('name=\\"member\\"');
  expect(actual).not.toContain("name=\"required\"");
  expect(actual).not.toContain("Notion metadata is pending");
  expect(actual.split("<ntn-skills-view-catalog>")).toHaveLength(2);
  expect(actual).toContain("sr:C");
  expect(before).not.toEqual(expect.arrayContaining([expect.objectContaining({ systemPrompt: expect.anything() })]));
  expect(projected).toEqual([expect.objectContaining({ messages: [expect.objectContaining({
    content: head.content, sections: expect.objectContaining(head.sections), toolsAdded: head.toolsAdded,
  }), expect.objectContaining({ role: "custom", customType: "context-broker-notion-catalog" }), user] })]);
  expect(JSON.stringify(messages)).toBe(original);
  expect(f.calls).toEqual(["use"]);
  expect(f.resourceReads).toEqual([]);
});

test("Pi default metadata survives an exact forced safety prompt without changing that prompt or loading bodies", async () => {
  const f = await fixture(true);
  const { search } = await f.install(undefined, { getRecords: async () => ({
    records: f.records.map(record => ({ ...record, body: undefined, preparationBinding: undefined,
      defaultDiscovery: record === f.root })), failures: [],
  }) });
  await search.execute("initial-directory", { query: "root" }, undefined, undefined, f.ctx);
  const forced = "Native rules\n<safe-delete-policy>Preserve deletion protections exactly.</safe-delete-policy>";
  const head = { role: "system", content: "Native rules", sections: { local: "Existing local rules" },
    toolsAdded: [{ name: "read" }] };
  const user = { role: "user", content: "Report the default directory without loading any Skill." };
  const input = [head, user], before = JSON.stringify(input);
  const outputs = await f.emit("context_with_system", { messages: input }, f.ctx);
  const output = outputs.find(value => value && typeof value === "object" && "messages" in value && Array.isArray(value.messages));
  if (!output || typeof output !== "object" || !("messages" in output) || !Array.isArray(output.messages)) throw new Error("Expected final Broker projection");
  // Pi applies an exact before_agent_start override after final context hooks.
  const provider = [{ role: "system", content: forced, toolsAdded: head.toolsAdded },
    ...output.messages.filter((message: AgentMessage) => message.role !== "system")];
  expect(JSON.stringify(provider)).toContain('name=\\"root\\"');
  expect(provider[0]).toEqual({ role: "system", content: forced, toolsAdded: head.toolsAdded });
  expect(provider).toContainEqual(user);
  expect(JSON.stringify(provider)).not.toContain(f.root.body!);
  expect(JSON.stringify(input)).toBe(before);
  const repeated = await f.emit("context_with_system", { messages: output.messages }, f.ctx);
  expect(repeated).toEqual(outputs);
  expect(JSON.stringify(repeated).split("<ntn-skills-view-catalog>")).toHaveLength(2);
  expect(f.calls).toEqual([]);
  expect(f.resourceReads).toEqual([]);
});

test("Pi keeps ordinary pending requests immediate and refreshes only its directory metadata on a later request", async () => {
  const f = await fixture(true), metadata = Promise.withResolvers<Awaited<ReturnType<HostSkillOptions["getRecords"]>>>();
  const { search } = await f.install(undefined, { getRecords: () => metadata.promise });
  const local = "<available_skills><skill><name>local-native</name><location>/local/skill/SKILL.md</location></skill></available_skills>";
  const head = { role: "system", content: "Native instructions", sections: { skills: local }, toolsAdded: [{ name: "read" }] };
  const user = { role: "user", content: "Keep this literal <ntn-skills-view-catalog>author text</ntn-skills-view-catalog>" };
  const before = await f.emit("before_agent_start", { prompt: user.content, systemPrompt: head.content }, f.ctx);
  const beforePrompt = before.flatMap(result => result && typeof result === "object" && "systemPrompt" in result && typeof result.systemPrompt === "string"
    ? [result.systemPrompt] : []).at(-1) ?? head.content;
  const messages = [{ ...head, content: beforePrompt }, user];
  const pending = await f.emit("context_with_system", { messages }, f.ctx);
  expect(JSON.stringify(pending.length ? pending : { messages })).toContain("Notion metadata is pending");
  expect(f.calls).toEqual([]);
  metadata.resolve({ records: f.records.map(record => ({ ...record, body: undefined, preparationBinding: undefined,
    defaultDiscovery: record === f.root })), failures: [] });
  await search.execute("metadata-ready", { query: "root" }, undefined, undefined, f.ctx);
  const stale = { ...head, content: head.content + "\n<ntn-skills-discovery status=\"pending\">obsolete state</ntn-skills-discovery>",
    sections: { skills: local + `<available_skills><skill><name>old-broker-index</name><location>${f.root.path}</location></skill></available_skills>`,
      "context-broker-notion-catalog": "<ntn-skills-view-catalog>obsolete catalog</ntn-skills-view-catalog>", other: null } };
  const patch = { role: "system", content: "Additional native instructions", sections: { extra: "Keep the native patch" }, toolsRemoved: [{ name: "obsolete-tool" }] };
  const original = JSON.stringify([stale, user, patch]);
  const ready = await f.emit("context_with_system", { messages: [stale, user, patch] }, f.ctx);
  const actual = JSON.stringify(ready);
  expect(actual).toContain('name=\\"root\\"');
  expect(actual).toContain("<name>local-native</name>");
  expect(actual).not.toContain("old-broker-index");
  expect(actual).not.toContain("obsolete state");
  expect(actual).not.toContain("obsolete catalog");
  expect(actual).not.toContain("Notion metadata is pending");
  expect(ready).toEqual([expect.objectContaining({ messages: [expect.objectContaining({ toolsAdded: head.toolsAdded,
    sections: expect.objectContaining({ other: null }) }), expect.objectContaining({ role: "custom", customType: "context-broker-notion-catalog" }), user, patch] })]);
  expect(JSON.stringify([stale, user, patch])).toBe(original);
  expect(f.calls).toEqual([]);
  expect(f.resourceReads).toEqual([]);
});

test("explicit Notion workflow discovery stays scoped while its default directory is pending", async () => {
  const f = await fixture(true), metadata = Promise.withResolvers<Awaited<ReturnType<HostSkillOptions["getRecords"]>>>();
  f.api.getActiveTools = () => ["read", "notion_list", "notion_use", "bash"];
  const { search } = await f.install(undefined, { getRecords: () => metadata.promise });
  installSkillGuidance(f.api, { sources: f.sources }, { host: "pi" });
  const user = { role: "user", content: "Inspect the team's ntn-skills-maintain workflow in this Notion library." };
  const before = await f.emit("before_agent_start", { prompt: user.content, systemPrompt: "Native instructions" }, f.ctx);
  const expected = buildCliGuidance({ sources: f.sources }, f.api.getActiveTools());
  expect(before).toContainEqual({ message: expected });
  const guidance: AgentMessage = { ...expected, role: "custom" };
  const messages = [{ role: "system", content: "Native instructions" }, user, guidance];
  const pending = await catalogProjection(f, messages);
  expect(pending.catalog).toContain("Notion metadata is pending");
  expect(sourceMessageText(guidance.content)).toContain("Explicit Notion workflow: read exact ref in chosen source; notion_list there if needed.");
  expect(sourceMessageText(guidance.content)).toContain("Pending/failed: no builtin fallback.");
  expect(sourceMessageText(guidance.content)).toContain("Default product maintenance/sync:");
  expect(sourceMessageText(guidance.content)).not.toContain('"skills","get"');
  metadata.resolve({ records: [{ ...f.root, name: "ntn-skills-maintain", alias: "ntn-skills-maintain",
    normalizedName: "ntn-skills-maintain", body: undefined, preparationBinding: undefined, defaultDiscovery: true }], failures: [] });
  const listed = await search.execute("maintenance-discovery", { query: "ntn-skills-maintain", source: "controlled" }, undefined, undefined, f.ctx);
  const ready = await catalogProjection(f, messages);
  expect(ready.catalog).toContain('name="ntn-skills-maintain"');
  expect(ready.catalog).toContain('source="controlled"');
  const ref = /location="(sr:C[A-Za-z0-9_-]+)"/.exec(ready.catalog)?.[1];
  if (!ref) throw new Error("Expected the scoped maintenance candidate's short reference");
  expect(sourceMessageText(listed.content)).toContain(ref);
  expect(ready.catalog).not.toContain("metadata is pending");
  expect(f.calls).toEqual([]);
  expect(f.persisted).toEqual([]);
  expect(f.resourceReads).toEqual([]);
});

async function catalogProjection(f: Awaited<ReturnType<typeof fixture>>, input: AgentMessage[]) {
  const outputs = await f.emit("context_with_system", { messages: input }, f.ctx);
  const output = outputs.find(value => value !== null && typeof value === "object" && "messages" in value && Array.isArray(value.messages));
  if (!output || typeof output !== "object" || !("messages" in output) || !Array.isArray(output.messages)) throw new Error("Expected actual final context projection");
  const messages: unknown[] = output.messages;
  const head = messages.find(value => value !== null && typeof value === "object" && "role" in value && value.role === "system");
  if (!head || typeof head !== "object") throw new Error("Expected the native system message");
  const catalog = messages.find(value => value && typeof value === "object" && "role" in value && value.role === "custom"
    && "customType" in value && value.customType === "context-broker-notion-catalog");
  if (catalog === undefined) return { messages, catalog: "" };
  if (!catalog || typeof catalog !== "object" || !("content" in catalog) || typeof catalog.content !== "string") throw new Error("Expected generated catalog text");
  return { messages, catalog: catalog.content };
}

function projectedToolText(messages: readonly unknown[], id: string): string {
  const message = messages.find(value => value !== null && typeof value === "object" && "toolCallId" in value && value.toolCallId === id);
  if (!message || typeof message !== "object" || !("content" in message)) throw new Error("Expected actual projected tool result");
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content) || message.content.length !== 1) throw new Error("Expected one original text part");
  const part: unknown = message.content[0];
  if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") throw new Error("Expected actual tool text");
  return part.text;
}

test("duplicate default cards cannot remove every complete description", () => {
  const card = { ref: "sr:C" + "a".repeat(22), source: "controlled", scope, kind: "skill", name: "member", description: "Complete metadata", availability: "available" };
  const result = projectCatalogDescriptions({ messages: [], defaults: [card, { ...card }], identify: value => JSON.stringify(value) });
  expect([...result.omittedDefaults]).toEqual([]);
});

async function dollarCatalogFixture() {
  const f = await fixture(true, false, "pi", scope, true);
  const { search, host } = await f.install(undefined, { getRecords: async () => ({ records: f.records.map(record => ({
    ...record, body: undefined, preparationBinding: undefined, defaultDiscovery: true,
  })), failures: [] }) });
  await search.execute("dollar-catalog", {}, undefined, undefined, f.ctx);
  await host.prepareMany([f.root], f.ctx);
  const injection = (record: SkillRecord) => buildInjectedContextMessage(record, record.name, {}, {
    sourceReference: value => host.selectedModelReference(value, f.ctx),
    sourceFiles: value => host.selectedModelFiles(value, f.ctx),
  });
  return { ...f, injection, injected: injection(f.root), requiredInjection: injection(f.required),
    head: { role: "system", content: "Native rules" } satisfies AgentMessage };
}

test("Pi dollar injection reuses an exact canonical card while retaining every source byte and default identity", async () => {
  const f = await dollarCatalogFixture(), input = [f.head, f.injected, f.requiredInjection], before = JSON.stringify(input);
  const initial = await catalogProjection(f, [f.head]), projected = await catalogProjection(f, input);
  expect(initial.catalog).toContain('Controlled member &lt;metadata&gt; &amp; "原文".');
  expect(projected.catalog).not.toContain('Controlled member &lt;metadata&gt;');
  expect(projected.catalog).toContain('>Controlled root</card>');
  expect(projected.catalog).toContain('>Controlled required</card>');
  expect(projected.catalog.match(/<card\b/g)).toHaveLength(3);
  const locations = (catalog: string) => [...catalog.matchAll(/\blocation="([^"]*)"/g)].map(match => match[1]);
  expect(locations(projected.catalog)).toEqual(locations(initial.catalog));
  expect(projected.messages.slice(2)).toEqual([f.injected, f.requiredInjection]);
  expect(JSON.stringify(input)).toBe(before);
  expect(sourceBodyLoaded(input, f.root)).toBe(true);
  expect(sourceBodyLoaded(input, f.required)).toBe(true);
  expect(f.calls).toEqual(["use"]);
  expect(f.resourceReads).toEqual([]);
});

test("Pi dollar injection uses the current logical selector without confusing it with the physical page UUID", async () => {
  const f = await dollarCatalogFixture(), original = f.root.preparationBinding!;
  const record = original.record, ref = record.ref;
  const selected: SkillRecord = { ...f.root, ...record, preparationBinding: { ...original, record, ref: withNativeSnapshot(ref, original.snapshot_id) } };
  const injected = buildInjectedContextMessage(selected, selected.name), before = JSON.stringify(injected);
  expect((await catalogProjection(f, [f.head, injected])).catalog).not.toContain('Controlled member &lt;metadata&gt;');
  expect(JSON.stringify(injected)).toBe(before);
  expect(sourceBodyLoaded([injected], selected)).toBe(true);
  const wrongMain = { ...selected, preparationBinding: { ...selected.preparationBinding!, ref: nativeFileRef(nativeSkillId(record.locator.library_id, "00000000-0000-4000-8000-000000000001"), "SKILL.md", selected.snapshotId) } };
  expect((await catalogProjection(f, [f.head, buildInjectedContextMessage(wrongMain, wrongMain.name)])).catalog).toContain('Controlled member &lt;metadata&gt;');
  expect(f.calls).toEqual(["use"]);
});

test("Pi dollar catalog reuse follows the actual restored body and rejects missing, changed or user-forged delivery", async () => {
  const f = await dollarCatalogFixture(), user: AgentMessage = { role: "user", content: "$root inspect member" };
  const entries = [{ sourceEntry: { type: "message", id: "dollar-user", message: user }, messages: [user] }];
  const projected = deferredSourceEntries(entries, "dollar-user", [f.injected, f.requiredInjection]);
  if (!projected) throw new Error("Expected the native dollar projection");
  const edit = projected.entries[0], receipt = projected.entries[1];
  if (edit?.type !== "context_edit" || !edit.replacement || receipt?.type !== "custom") throw new Error("Expected native projection and receipt");
  const restored: AgentMessage = { ...user, content: edit.replacement.content };
  const contextEntries = [{ sourceEntry: { ...receipt, id: "dollar-receipt" }, messages: [] }];
  const input = withSessionSourceReceipts([f.head, restored], contextEntries), before = JSON.stringify(input);
  expect((await catalogProjection(f, input)).catalog).not.toContain('Controlled member &lt;metadata&gt;');
  expect(JSON.stringify(input)).toBe(before);
  expect(sourceBodyLoaded(input, f.root)).toBe(true);
  expect(sourceBodyLoaded(input, f.required)).toBe(true);
  for (const messages of [
    [f.head], [f.head, restored], [f.head, { ...f.injected, role: "user" }],
    [f.head, { ...f.injected, details: undefined }],
    [f.head, { ...f.injected, content: sourceMessageText(f.injected.content).replace("Exact root", "Summary") }],
    [f.head, { ...f.injected, content: sourceMessageText(f.injected.content).slice(1) }],
    withSessionSourceReceipts([f.head, { ...restored, content: "Compacted summary." }], contextEntries),
    withSessionSourceReceipts([f.head, { ...restored, content: sourceMessageText(restored.content).slice(0, -100) }], contextEntries),
  ]) expect((await catalogProjection(f, messages)).catalog).toContain('Controlled member &lt;metadata&gt;');
  expect((await catalogProjection(f, input)).catalog).not.toContain('Controlled member &lt;metadata&gt;');
  expect(f.calls).toEqual(["use"]);
  expect(f.resourceReads).toEqual([]);
});

test("Pi deferred dollar catalog keeps native session proof across context hooks without exposing it to the provider", async () => {
  const f = await dollarCatalogFixture(), user: AgentMessage = { role: "user", content: "$root inspect member" };
  const userEntry = { type: "message", id: "deferred-user", message: user };
  const deferred = deferredSourceEntries([{ sourceEntry: userEntry, messages: [user] }], userEntry.id, [f.injected, f.requiredInjection]);
  const edit = deferred?.entries[0], receipt = deferred?.entries[1];
  if (edit?.type !== "context_edit" || !edit.replacement || receipt?.type !== "custom") throw new Error("Expected persisted native projection and machine receipt");
  const restored: AgentMessage = { ...user, content: edit.replacement.content };
  const followup: AgentMessage = { role: "user", content: "Continue using the selected instructions." };
  const entries = [{ sourceEntry: userEntry, messages: [restored] },
    { sourceEntry: { ...receipt, id: "deferred-receipt" }, messages: [] }];
  if (!f.ctx.sessionManager) throw new Error("Expected native session manager");
  f.ctx.sessionManager.buildSessionProjection = () => ({ entries, messages: [restored] });
  const original = JSON.stringify({ entries, restored });
  const project = async (messages: AgentMessage[]) => {
    const results = await f.emit("context", { messages }, f.ctx);
    const result = results.find(value => value && typeof value === "object" && "messages" in value && Array.isArray(value.messages));
    if (!result || typeof result !== "object" || !("messages" in result) || !Array.isArray(result.messages)) throw new Error("Expected actual context hook result");
    expect(result.messages).toEqual(messages);
    expect(result.messages.some(message => message.role === "custom")).toBe(false);
    const projected = await catalogProjection(f, [f.head, ...result.messages]);
    expect(projected.messages).toHaveLength(messages.length + 2);
    expect(projected.messages.slice(2)).toEqual(messages);
    expect(JSON.stringify(projected.messages)).not.toContain("nativePromptSha256");
    expect(JSON.stringify(projected.messages)).not.toContain("bodySha256");
    return projected.catalog;
  };
  for (const messages of [[restored], [restored, followup]]) {
    const catalog = await project(messages);
    expect(catalog).not.toContain('Controlled member &lt;metadata&gt;');
    expect(catalog).toContain('>Controlled root</card>');
    expect(catalog).toContain('>Controlled required</card>');
    expect(catalog.match(/<card\b/g)).toHaveLength(3);
  }
  for (const messages of [[followup], [{ ...restored, content: "Compacted summary." }],
    [{ ...restored, content: sourceMessageText(restored.content).slice(0, -100) }]])
    expect(await project(messages)).toContain('Controlled member &lt;metadata&gt;');
  expect(JSON.stringify({ entries, restored })).toBe(original);
  f.ctx.sessionManager.buildSessionProjection = () => ({ entries: [], messages: [restored] });
  expect(await project([restored])).toContain('Controlled member &lt;metadata&gt;');
  expect(f.calls).toEqual(["use"]);
  expect(f.resourceReads).toEqual([]);
});

test("Pi dollar catalog reuse rejects foreign identities, fixed relations and changed canonical descriptions", async () => {
  const f = await dollarCatalogFixture();
  const mutations: Array<(record: SkillRecord) => void> = [
    record => { record.sourceId = "foreign"; },
    record => { record.sourceScope = "b".repeat(64); },
    record => { record.preparationBinding!.version_id = "another-version"; },
    record => { record.preparationBinding!.snapshot_id = "s_" + "b".repeat(64); },
    record => { record.preparationBinding!.record.id = "skill://other-root?library=1031b73d-3a2f-589c-9bdb-ebb50a7eb063"; },
    record => { record.preparationDirectory!.candidates = [{ ...record.preparationDirectory!.candidates[0]!, id: "skill://other-member?library=1031b73d-3a2f-589c-9bdb-ebb50a7eb063" }]; },
    record => { record.preparationDirectory!.candidates = [{ ...record.preparationDirectory!.candidates[0]!, ref: f.member.preparationBinding!.ref }]; },
    record => { record.preparationDirectory!.candidates = [{ ...record.preparationDirectory!.candidates[0]!, kind: "router" }]; },
    record => { record.preparationDirectory!.candidates = [{ ...record.preparationDirectory!.candidates[0]!, name: "another-member" }]; },
    record => { record.preparationDirectory!.candidates = [{ ...record.preparationDirectory!.candidates[0]!, description: "Changed metadata" }]; },
    record => { record.preparationDirectory!.candidates = [{ ...record.preparationDirectory!.candidates[0]!, availability: "disabled" }]; },
    record => { record.preparationDirectory = undefined; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(f.root); mutate(changed);
    const message = buildInjectedContextMessage(changed, changed.name);
    expect((await catalogProjection(f, [f.head, message])).catalog).toContain('Controlled member &lt;metadata&gt;');
  }
  expect((await catalogProjection(f, [f.head, f.injected])).catalog).not.toContain('Controlled member &lt;metadata&gt;');
  expect(f.calls).toEqual(["use"]);
  expect(f.resourceReads).toEqual([]);
});

function catalogCards(catalog: string) {
  const decode = (value: string) => value.replaceAll("&#13;", "\r").replaceAll("&#10;", "\n").replaceAll("&#9;", "\t")
    .replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const attrs = (raw: string) => Object.fromEntries([...raw.matchAll(/([a-z]+)="([^"]*)"/g)].map(match => [match[1]!, decode(match[2]!)]));
  return [...catalog.matchAll(/<group\b([^>]*)>([\s\S]*?)<\/group>/g)].flatMap(group => {
    const header = attrs(group[1] ?? "");
    return [...(group[2] ?? "").matchAll(/<card\b([^>]*?)\/>|<card\b([^>]*)>([\s\S]*?)<\/card>/g)].map(card => {
      const self = card[1] !== undefined;
      const fields = attrs((self ? card[1] : card[2]) ?? "");
      return { name: fields.name, source: fields.source ?? header.source, location: fields.location,
        description: self ? undefined : decode(card[3] ?? "") };
    });
  });
}

test("Pi dollar catalog reuse preserves same-name sources, owners and newly observed descriptions", async () => {
  const f = await fixture(true, false, "pi", scope, true), head: AgentMessage = { role: "system", content: "Native rules" };
  f.sources.push({ id: "other-source", type: "notion", prefetch: false });
  const id = "skill://other-member?library=1031b73d-3a2f-589c-9bdb-ebb50a7eb063";
  const otherOwner = { ...f.member, id, token: "other-owner-member", ref: nativeFileRef(id, "SKILL.md"),
    locator: { ...f.member.locator!, skill_id: "other-member", page_id: "00000000-0000-4000-8000-000000000004" } };
  const otherSource = { ...f.member, sourceId: "other-source", token: "other-source-member" };
  const { search, host } = await f.install(undefined, { getRecords: async () => ({ records: [...f.records, otherOwner, otherSource].map(record => ({
    ...record, body: undefined, preparationBinding: undefined, defaultDiscovery: true,
  })), failures: [] }) });
  await search.execute("dollar-aliases", {}, undefined, undefined, f.ctx);
  await host.prepareMany([f.root], f.ctx);
  const injected = buildInjectedContextMessage(f.root, "root");
  const projected = await catalogProjection(f, [head, injected]);
  const members = catalogCards(projected.catalog).filter(card => card.name === "member");
  expect(members).toHaveLength(3);
  const sameSource = members.filter(card => card.source === "controlled");
  expect(sameSource).toHaveLength(2);
  expect(sameSource.filter(card => card.description !== undefined)).toHaveLength(1);
  expect(members.find(card => card.source === "other-source")?.description).toBeDefined();
  const before = sourceMessageText(injected.content);
  f.member.description = "New authoritative member description.";
  await host.refresh(f.ctx);
  const refreshed = await catalogProjection(f, [head, injected]);
  expect(refreshed.catalog).toContain("New authoritative member description.");
  expect(refreshed.catalog.match(/<\/card>/g)).toHaveLength(5);
  expect(sourceMessageText(injected.content)).toBe(before);
  expect(f.calls).toEqual(["use"]);
  expect(f.resourceReads).toEqual([]);
});

test("same current ref in two configured sources retains the unwitnessed source description", async () => {
  const f = await fixture(true), head: AgentMessage = { role: "system", content: "Native rules" };
  f.sources.push({ id: "other-source", type: "notion", prefetch: false });
  const alias = { ...f.member, sourceId: "other-source", token: "other-member" };
  const { search } = await f.install(undefined, { getRecords: async () => ({ records: [...f.records, alias].map(record => ({
    ...record, body: undefined, preparationBinding: undefined, defaultDiscovery: true,
  })), failures: [] }) });
  await search.execute("alias-catalog", {}, undefined, undefined, f.ctx);
  const read = await nativeRead(f, f.root.ref!, "alias-inspect");
  const projected = await catalogProjection(f, [head, read]);
  const cards = catalogCards(projected.catalog);
  const original = cards.find(card => card.name === "member" && card.source === "controlled");
  const other = cards.find(card => card.name === "member" && card.source === "other-source");
  expect(original).toBeDefined(); expect(other).toBeDefined();
  expect(original?.location).toBe(other?.location);
  expect(original?.description).toBeUndefined();
  expect(other?.description).toBe("Controlled member");
  expect(projected.messages).toContain(read);
  expect(f.calls).toEqual(["inspect"]);
});

test("Pi native inspect reuses only its verified generated footer without changing author bytes", async () => {
  const f = await fixture(true), head: AgentMessage = { role: "system", content: "Native rules" };
  const { search } = await f.install(undefined, { getRecords: async () => ({ records: f.records.map(record => ({
    ...record, body: undefined, preparationBinding: undefined, defaultDiscovery: true,
  })), failures: [] }) });
  const listed = await search.execute("inspect-list", { query: "member" }, undefined, undefined, f.ctx);
  const read = await nativeRead(f, f.root.ref!, "inspect-main");
  const original = JSON.stringify(read), body = sourceMessageText(read.content);
  const list: AgentMessage = { role: "toolResult", toolName: "notion_list", toolCallId: "inspect-list", content: listed.content, details: listed.details, isError: false };
  const projected = await catalogProjection(f, [head, list, read]);
  expect(projected.catalog).not.toContain('>Controlled member</card>');
  expect(projected.catalog).toContain(">Controlled root</card>");
  expect(JSON.parse(projectedToolText(projected.messages, "inspect-list")).records[0].description).toBeUndefined();
  expect(projected.messages).toContain(read);
  expect(JSON.stringify(read)).toBe(original);
  expect(body.startsWith(f.root.body!)).toBe(true);
  expect(sourceBodyLoaded([read], f.root)).toBe(true);
  expect(sourceBodyLoaded([read], f.required)).toBe(false);
  const details = read.details;
  if (!details || typeof details !== "object" || Array.isArray(details) || !("contextBrokerRead" in details)) throw new Error("Missing native read receipt");
  const proof = details.contextBrokerRead;
  if (!proof || typeof proof !== "object" || Array.isArray(proof) || !("binding" in proof) || !("identity" in proof)) throw new Error("Missing native identity");
  const binding = proof.binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding) || !("record" in binding)) throw new Error("Missing native binding");
  const record = binding.record;
  if (!record || typeof record !== "object" || Array.isArray(record) || !("locator" in record)) throw new Error("Missing native locator");
  const locator = record.locator;
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) throw new Error("Missing native locator fields");
  const identity: unknown = JSON.parse(String(proof.identity));
  if (!Array.isArray(identity) || identity.length !== 5) throw new Error("Expected full configured source identity");
  for (const candidate of [
    { ...read, role: "user" }, { ...read, isError: true }, { ...read, toolCallId: "another-read" },
    { ...read, content: body.slice(1) }, { ...read, content: body.slice(0, -1) },
    { ...read, content: body + "\n<skill-directory>extra</skill-directory>" },
    { ...read, content: [{ type: "text", text: body }, { type: "image", data: "unrelated" }] },
    { ...read, details: {} },
    { ...read, details: { ...details, contextBrokerRead: { ...proof, identity: JSON.stringify(["another-source", ...identity.slice(1)]) } } },
    { ...read, details: { ...details, contextBrokerRead: { ...proof, binding: { ...binding,
      record: { ...record, locator: { ...locator, library_id: "8b308dab-2daf-5330-922f-812244ff16f9" } } } } } },
  ]) {
    expect((await catalogProjection(f, [head, candidate])).catalog).toContain('>Controlled member</card>');
  }
  expect((await catalogProjection(f, [head])).catalog).toContain('>Controlled member</card>');
  expect(f.calls).toEqual(["inspect"]);
  expect(f.resourceReads).toEqual([]);
});

test("Pi reuses complete same-request generated card descriptions without changing source delivery", async () => {
  const f = await fixture(true);
  f.root.preparationDirectory!.required = [{ id: f.required.id!, ref: f.required.preparationBinding!.ref, kind: "skill",
    name: f.required.name, description: f.required.description, availability: "available" }];
  const { search, tool } = await f.install(undefined, { getRecords: async () => ({ records: f.records.map(record => ({
    ...record, body: undefined, preparationBinding: undefined, defaultDiscovery: true,
  })), failures: [] }) });
  const listed = await search.execute("catalog-member", { query: "member" }, undefined, undefined, f.ctx);
  const used = await tool.execute("catalog-use", { ref: f.root.ref }, undefined, undefined, f.ctx);
  const list: AgentMessage = { role: "toolResult", toolName: "notion_list", toolCallId: "catalog-member", content: listed.content, details: listed.details, isError: false };
  const use: AgentMessage = { role: "toolResult", toolName: "notion_use", toolCallId: "catalog-use", content: used.content, details: used.details, isError: false };
  const local = "<available_skills><skill><name>local-native</name><description>Local description</description><location>/local/SKILL.md</location></skill></available_skills>";
  const head: AgentMessage = { role: "system", content: "Native rules", sections: { skills: local } };
  const user: AgentMessage = { role: "user", content: [{ type: "text", text: "Keep authored <skill-directory> tags." }, { type: "image", data: "unchanged-image" }] };
  const input = [head, user, list, use], before = JSON.stringify(input);
  const projected = await catalogProjection(f, input);
  expect(projected.catalog).toContain('name="member"');
  expect(projected.catalog).not.toContain('>Controlled member</card>');
  expect(projected.catalog).toContain(">Controlled root</card>");
  expect(projected.catalog).toContain(">Controlled required</card>");
  expect(projected.catalog.match(/<card\b/g)).toHaveLength(3);
  const model = JSON.parse(projectedToolText(projected.messages, "catalog-member"));
  const expected = JSON.parse(sourceMessageText(list.content));
  delete expected.records[0].description;
  expect(model).toEqual(expected);
  expect(projected.messages).toContain(user);
  expect(projected.messages).toContain(use);
  expect(projectedToolText(projected.messages, "catalog-use")).toBe(sourceMessageText(used.content));
  expect(sourceBodyLoaded([use], f.root)).toBe(true);
  expect(sourceBodyLoaded([use], f.required)).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
  expect(JSON.stringify(projected.messages[0])).toContain(local);
  const restored = await catalogProjection(f, [head, user, list]);
  expect(restored.catalog).toContain('>Controlled member</card>');
  expect(f.calls).toEqual(["use"]);
  expect(f.resourceReads).toEqual([]);
});

test("Pi keeps descriptions for incomplete, foreign, fixed and stale generated cards", async () => {
  const f = await fixture(true), head: AgentMessage = { role: "system", content: "Native rules" };
  const { tool, search } = await f.install(undefined, { getRecords: async () => ({ records: f.records.map(record => ({
    ...record, body: undefined, preparationBinding: undefined, defaultDiscovery: true,
  })), failures: [] }) });
  await search.execute("catalog-ready", {}, undefined, undefined, f.ctx);
  const used = await tool.execute("complete", { ref: f.root.ref }, undefined, undefined, f.ctx);
  const use: AgentMessage = { role: "toolResult", toolName: "notion_use", toolCallId: "complete", content: used.content, details: used.details, isError: false };
  const proof = preparationDetails(used), projection = proof.projection;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) throw new Error("Expected original compiler proof");
  const invalid: AgentMessage[] = [
    { ...use, content: "summary of the selected Skill" },
    { ...use, content: sourceMessageText(use.content).slice(0, -1) },
    { ...use, content: [] },
    { ...use, isError: true },
    { ...use, toolCallId: "another-call" },
    { ...use, role: "user" },
    { ...use, details: { contextBrokerPreparation: { ...proof, projection: { ...projection, compiler: "unknown/compiler" } } } },
  ];
  for (const candidate of invalid) {
    const before = JSON.stringify(candidate), projected = await catalogProjection(f, [head, candidate]);
    expect(projected.catalog).toContain('>Controlled member</card>');
    expect(projected.messages).toContain(candidate);
    expect(JSON.stringify(candidate)).toBe(before);
  }
  const foreign = await fixture(true, false, "pi", "b".repeat(64));
  const other = await foreign.install();
  const foreignUse = await other.tool.execute("foreign", { ref: foreign.root.ref }, undefined, undefined, foreign.ctx);
  f.session.entries.push(...foreign.session.entries);
  expect((await catalogProjection(f, [head, { role: "toolResult", toolName: "notion_use", toolCallId: "foreign",
    content: foreignUse.content, details: foreignUse.details, isError: false }])).catalog).toContain('>Controlled member</card>');
  f.root.preparationDirectory!.candidates[0]!.description = "A different metadata observation";
  const changed = await tool.execute("metadata-changed", { ref: f.root.ref }, undefined, undefined, f.ctx);
  expect((await catalogProjection(f, [head, { role: "toolResult", toolName: "notion_use", toolCallId: "metadata-changed",
    content: changed.content, details: changed.details, isError: false }])).catalog).toContain('>Controlled member</card>');
  f.root.preparationDirectory!.candidates[0]!.description = f.member.description;
  f.root.preparationDirectory!.candidates[0]!.ref = withNativeSnapshot(f.member.ref, "s_" + hash("historical-member"));
  const fixed = await tool.execute("fixed-candidate", { ref: f.root.ref }, undefined, undefined, f.ctx);
  expect((await catalogProjection(f, [head, { role: "toolResult", toolName: "notion_use", toolCallId: "fixed-candidate",
    content: fixed.content, details: fixed.details, isError: false }])).catalog).toContain('>Controlled member</card>');
  f.session.entries = [];
  expect((await catalogProjection(f, [head, use])).catalog).toContain('>Controlled member</card>');
  expect(f.calls).toEqual(["use", "use", "use"]);
  expect(f.resourceReads).toEqual([]);
});

test("Pi discovery description reuse requires exact visible metadata and restores after its complete card leaves context", async () => {
  const f = await fixture(true), head: AgentMessage = { role: "system", content: "Native rules" };
  f.api.getActiveTools = () => ["read", "notion_list", "notion_use"];
  const { search } = await f.install();
  const one = await search.execute("first-metadata", { query: "member" }, undefined, undefined, f.ctx);
  const two = await search.execute("second-metadata", { query: "member" }, undefined, undefined, f.ctx);
  const first: AgentMessage = { role: "toolResult", toolName: "notion_list", toolCallId: "first-metadata", content: one.content, details: one.details, isError: false };
  const second: AgentMessage = { role: "toolResult", toolName: "notion_list", toolCallId: "second-metadata", content: two.content, details: two.details, isError: false };
  const original = JSON.stringify([first, second]);
  const projected = await catalogProjection(f, [head, first, second]);
  expect(projected.messages).toContain(first);
  expect(JSON.parse(projectedToolText(projected.messages, "second-metadata")).records[0].description).toBeUndefined();
  expect(JSON.stringify([first, second])).toBe(original);
  const restored = await catalogProjection(f, [head, second]);
  expect(projectedToolText(restored.messages, "second-metadata")).toBe(sourceMessageText(second.content));
  for (const invalid of [
    { ...first, role: "user" }, { ...first, content: "Summary: Controlled member" }, { ...first, isError: true },
    { ...first, details: {} }, { ...first, content: [] },
  ]) {
    const result = await catalogProjection(f, [head, invalid, second]);
    expect(projectedToolText(result.messages, "second-metadata")).toBe(sourceMessageText(second.content));
  }
  for (const change of [{ source: "other-source" }, { scope: "b".repeat(64) }, { description: "different metadata" }]) {
    const details = JSON.parse(JSON.stringify(one.details));
    Object.assign(details.records[0], change);
    const model = { ...details, records: details.records.map(({ id: _id, scope: _scope, ...record }: Record<string, unknown>) => record) };
    const invalid: AgentMessage = { ...first, content: JSON.stringify(model), details };
    const result = await catalogProjection(f, [head, invalid, second]);
    expect(projectedToolText(result.messages, "second-metadata")).toBe(sourceMessageText(second.content));
  }
  expect(f.calls).toEqual([]);
  expect(f.resourceReads).toEqual([]);
});

class PreparationText {
  constructor(readonly text: string) {}
  render() { return this.text.split("\n"); }
  invalidate() {}
}
type PreparationEntryRenderer = Parameters<NonNullable<ExtensionAPI["registerEntryRenderer"]>>[1];
const preparationTheme = { fg: (_color: string, value: string) => value };

test("Pi preparation uses a transcript entry and fences cancelled or revoked feedback", async () => {
  const f = await fixture();
  const messages: unknown[] = [], entries: SessionEntry[] = [];
  let renderer: PreparationEntryRenderer | undefined, widgets = 0;
  const api: ExtensionAPI = { pi: { Text: PreparationText }, on() {},
    registerEntryRenderer(type, value) { expect(type).toBe(ACTIVATION_MESSAGE); renderer = value; },
    sendMessage(message) { messages.push(message); }, appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); } };
  const feedback = await createActivationFeedback(api, () => {}, "entry");
  let session = "feedback-session", revoked = false;
  const context = new Proxy({ ...f.ctx, hasUI: true, mode: "tui" as const,
    ui: { setWidget() { widgets++; } }, sessionManager: { getSessionId: () => session, getBranch: () => [] },
  }, { get(target, key, receiver) { if (revoked) throw new Error("Revoked feedback context"); return Reflect.get(target, key, receiver); } });
  const source = { type: "notion" as const, id: "controlled", preparation: { maxNodes: 8, maxDepth: 4, maxInstructionBytes: 8192, maxContextBytes: 131072 } };
  const finish = feedback.begin(f.root, context, "use", source);
  expect(finish).toBeDefined(); expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ type: "custom", customType: ACTIVATION_MESSAGE, data: { status: "running" } });
  if (!renderer || !entries[0]) throw new Error("Expected an immediate preparation entry");
  const component = renderer(entries[0], { expanded: false }, preparationTheme);
  if (!component) throw new Error("Expected a preparation entry renderer");
  const rendered = () => stripVTControlCharacters(component.render(160).join("\n"));
  expect(rendered()).toBe("[skill@notion] root · loading…");
  expect(rendered()).not.toContain("bytes");
  expect(messages).toEqual([]); expect(widgets).toBe(0);
  finish!({ error: "Cancelled." });
  expect(rendered()).toContain(" · cancelled"); expect(entries).toHaveLength(2);
  finish!({ value: f.root }); expect(entries).toHaveLength(2);
  expect(rendered()).not.toContain("loaded");
  const late = feedback.begin(f.root, context, "use", source);
  expect(entries).toHaveLength(3);
  session = "replacement";
  feedback.restore({ ...context }); revoked = true;
  expect(() => late!({ value: f.root })).not.toThrow(); expect(entries).toHaveLength(3);
  expect(messages).toEqual([]); expect(widgets).toBe(0);
});

for (const accepted of [false, true])
test(`Pi dollar context keeps its ${accepted ? "loaded" : "ready"} transcript entry when the model request is stopped`, async () => {
  const f = await fixture(true), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const operation = new AbortController();
  let renderer: PreparationEntryRenderer | undefined, widgets = 0, messages = 0, confirmations = 0;
  f.api.pi = { Text: PreparationText };
  f.api.registerEntryRenderer = (type, value) => { expect(type).toBe(ACTIVATION_MESSAGE); renderer = value; };
  f.api.sendMessage = () => { messages++; };
  f.ctx.hasUI = true; f.ctx.mode = "tui"; f.ctx.signal = operation.signal;
  f.ctx.ui = { setWidget() { widgets++; } };
  await f.install(async purpose => { entered.resolve(); await release.promise; return [f.graph(purpose)]; }, {
    buildPreparedPrompt: async (_text, _ctx, _signal, records = []) => {
      const content = records.map(record => record.body!).join("\n\n");
      return { customType: "context-broker", content, display: false,
        details: { records: records.map(record => sourceDeliveryReceipt(record, content)) } };
    },
    confirmDelivery() { confirmations++; },
  });
  const user: AgentMessage = { role: "user", content: "$root explain this task" };
  let pending: Promise<unknown[]> | undefined;
  try {
    await f.emit("input", { source: "rpc", text: user.content }, f.ctx);
    await f.emit("before_agent_start", { prompt: user.content, systemPrompt: "base" }, f.ctx);
    await f.emit("agent_start", {}, f.ctx);
    pending = f.emit("context", { messages: [user] }, f.ctx);
    await Promise.race([entered.promise, pending.then(() => { throw new Error("Expected preparation to remain suspended"); })]);
    const rows = () => f.session.entries.filter(entry => entry.type === "custom" && entry.customType === ACTIVATION_MESSAGE);
    expect(rows()).toHaveLength(1);
    const row = rows()[0];
    expect(row).toMatchObject({ type: "custom", data: { status: "running", purpose: "use" } });
    if (!row || !renderer) throw new Error("Expected the live host's preparation entry");
    const component = renderer(row, { expanded: false }, preparationTheme);
    if (!component) throw new Error("Expected the live host's entry component");
    const rendered = () => stripVTControlCharacters(component.render(160).join("\n"));
    expect(rendered()).toBe("[skill@notion] root · loading…");
    expect(messages).toBe(0); expect(widgets).toBe(0); expect(confirmations).toBe(0);
    expect(f.persisted).toEqual([]);
    release.resolve();
    const output = (await pending).find(value => value && typeof value === "object" && "messages" in value && Array.isArray(value.messages));
    if (!output || typeof output !== "object" || !("messages" in output) || !Array.isArray(output.messages)) throw new Error("Expected complete source delivery");
    expect(sourceBodyLoaded(output.messages, f.root)).toBe(true);
    expect(sourceBodyLoaded(output.messages, f.required)).toBe(true);
    expect(rendered()).toBe("[skill@notion] root · ready");
    expect(rows()).toHaveLength(1); expect(confirmations).toBe(0); expect(f.persisted).toEqual([]);
    await f.emit("before_provider_request", {}, f.ctx);
    await f.emit("after_provider_response", { status: 503 }, f.ctx);
    expect(rendered()).toBe("[skill@notion] root · ready"); expect(confirmations).toBe(0);
    await f.emit("before_provider_request", {}, f.ctx);
    if (accepted) await f.emit("after_provider_response", { status: 200 }, f.ctx);
    const expected = `[skill@notion] root · ${accepted ? "loaded" : "ready"}`;
    expect(rendered()).toBe(expected);
    expect(rows()).toHaveLength(1); expect(confirmations).toBe(accepted ? 1 : 0);
    expect(f.persisted).toEqual(accepted ? ["extend"] : []);
    expect(messages).toBe(0); expect(widgets).toBe(0);
    expect(output.messages.some(message => message.customType === ACTIVATION_MESSAGE)).toBe(false);
    const count = f.session.entries.length;
    operation.abort();
    await f.emit("agent_end", {}, f.ctx);
    expect(rendered()).toBe(expected);
    await f.emit("after_provider_response", { status: 200 }, f.ctx);
    expect(rendered()).toBe(expected);
    expect(f.session.entries).toHaveLength(count);
    expect(confirmations).toBe(accepted ? 1 : 0);
    expect(f.persisted).toEqual(accepted ? ["extend"] : []);
  } finally {
    release.resolve(); await pending?.catch(() => undefined);
    await f.emit("agent_end", {}, f.ctx); await f.emit("session_shutdown", {}, f.ctx);
  }
});

for (const boundary of ["metadata", "use", "scalar preparation", "source native read"] as const)
for (const stop of ["deadline", "abort"] as const)
test(`public Broker ${boundary} settles on ${stop} without waiting for a non-cooperative producer`, async () => {
  const f = await fixture(true), operation = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let hold = false, sourceSignal: AbortSignal | undefined, nativeCalls = 0, aborts = 0;
  f.ctx.abort = () => { aborts++; operation.abort(); };
  const adapter = createPiHostAdapter(f.api);
  let executeRead: NativeReadExecutor | undefined;
  adapter.registerReadExecutor = execute => { executeRead = execute; return () => true; };
  const h = await f.install(async (purpose, signal, policy) => {
    policy?.observeEffects?.(noConsumptionWrites());
    if (hold && boundary !== "metadata" && boundary !== "source native read") {
      sourceSignal = signal; entered.resolve(); await release.promise;
    }
    return [{ ...f.graph(purpose), effects: noConsumptionWrites() }];
  }, { getRecords: async () => {
    if (hold && boundary === "metadata") { entered.resolve(); await release.promise; }
    return { records: f.records.map(record => ({ ...record, body: undefined, preparationBinding: undefined })), failures: [] };
  } }, adapter);
  await h.host.refresh(f.ctx);
  const history = JSON.stringify(f.session.entries);
  hold = true;
  const refresh = boundary === "metadata" ? h.host.refresh(f.ctx) : undefined;
  const nativeTimeout = globalThis.setTimeout;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
    nativeTimeout(callback, delay === 60_000 && stop === "deadline" ? 15 : delay, ...args));
  let pending: Promise<{ error: unknown } | { value: unknown }> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!executeRead) throw new Error("Expected native read boundary");
    const call = boundary === "metadata" ? h.search.execute("bounded-tool", {}, operation.signal, undefined, f.ctx)
      : boundary === "use" ? h.tool.execute("bounded-tool", { ref: f.root.ref }, operation.signal, undefined, f.ctx)
      : executeRead({ path: f.root.ref }, f.ctx, operation.signal, async (_input, signal) => {
        nativeCalls++;
        if (boundary === "source native read") { sourceSignal = signal; entered.resolve(); await release.promise; }
        return { content: [{ type: "text", text: f.root.body! }] };
      }, "bounded-tool");
    pending = call.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    // Source inspection can admit its fixed selection before the native reader
    // runs. Timeout must preserve that prior fact and add no later delivery.
    const admitted = f.persisted.slice();
    expect(admitted).toEqual(boundary === "source native read" ? ["extend"] : []);
    if (stop === "abort") operation.abort();
    const result = await Promise.race([pending, new Promise<undefined>(resolve => { watchdog = nativeTimeout(() => resolve(undefined), 100); })]);
    expect(result).toBeDefined();
    if (!result || !("error" in result)) throw new Error("Broker acquisition must settle before its producer is released");
    expect(result.error).toMatchObject({ code: stop === "abort" ? "SOURCE_ACTIVATION_CANCELLED" : "SOURCE_PREPARATION_TIMEOUT" });
    if (boundary !== "metadata") expect(sourceSignal?.aborted).toBe(true);
    expect(operation.signal.aborted).toBe(stop === "abort"); expect(aborts).toBe(0);
    expect(nativeCalls).toBe(boundary === "source native read" ? 1 : 0);
    expect(f.persisted).toEqual(admitted); expect(JSON.stringify(f.session.entries)).toBe(history);
    release.resolve(); await refresh;
    await new Promise(resolve => nativeTimeout(resolve, 0));
    expect(f.persisted).toEqual(admitted); expect(JSON.stringify(f.session.entries)).toBe(history);
    const late = await f.emit("tool_result", { toolName: "read", toolCallId: "bounded-tool", input: { path: f.root.ref },
      content: [{ type: "text", text: f.root.body! }], isError: false }, f.ctx);
    expect(late.every(value => value === undefined)).toBe(true);
    hold = false;
    expect((await h.search.execute("after-bounded-tool", { query: "root" }, undefined, undefined, f.ctx)).content).toBeDefined();
  } finally {
    if (watchdog) clearTimeout(watchdog);
    release.resolve(); await pending; await refresh;
    timeout.mockRestore(); await f.emit("session_shutdown", {}, f.ctx);
  }
});

for (const mode of ["metadata", "content", "cli source"] as const)
for (const stop of ["deadline", "abort"] as const)
test(`public Broker ${mode} bounds Library selection on ${stop} before remote dispatch`, async () => {
  const f = await fixture(true), operation = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const library = createLibrarySelection({ sources: [] });
  f.sources[0]!.library = "1031b73d-3a2f-589c-9bdb-ebb50a7eb063";
  f.api.getActiveTools = () => ["read", "bash", "notion_ctl"];
  const h = await f.install(undefined, { librarySelection: library });
  await h.host.refresh(f.ctx);
  const selected = spyOn(library, "selected").mockImplementation(async () => { entered.resolve(); await release.promise; return undefined; });
  const nativeTimeout = globalThis.setTimeout, budgets: number[] = [];
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    if (delay === 60_000 || delay === CONTENT_SEARCH_TIMEOUT_MS) budgets.push(delay);
    return nativeTimeout(callback, stop === "deadline" && (delay === 60_000 || delay === CONTENT_SEARCH_TIMEOUT_MS) ? 15 : delay, ...args);
  });
  let pending: Promise<{ error: unknown } | { value: unknown }> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = mode === "cli source" ? h.graphTool!.execute("held-library", { cli_source: null }, operation.signal, undefined, f.ctx)
      : h.search.execute("held-library", mode === "content" ? { search_in: "content", query: "needle" } : {}, operation.signal, undefined, f.ctx);
    pending = call.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    if (stop === "abort") operation.abort();
    const result = await Promise.race([pending, new Promise<undefined>(resolve => { watchdog = nativeTimeout(() => resolve(undefined), 100); })]);
    expect(result).toBeDefined();
    if (!result || !("error" in result)) throw new Error("Library selection must settle before its producer is released");
    expect(result.error).toMatchObject({ code: mode === "content" ? stop === "abort" ? "SOURCE_CANCELLED" : "CONTENT_SEARCH_TIMEOUT"
      : stop === "abort" ? "SOURCE_ACTIVATION_CANCELLED" : "SOURCE_PREPARATION_TIMEOUT" });
    expect(budgets).toContain(mode === "content" ? CONTENT_SEARCH_TIMEOUT_MS : 60_000);
    expect(f.calls).toEqual([]); expect(f.persisted).toEqual([]); expect(operation.signal.aborted).toBe(stop === "abort");
    release.resolve(); await new Promise(resolve => nativeTimeout(resolve, 0));
    expect(f.calls).toEqual([]); expect(f.persisted).toEqual([]); expect(f.session.entries).toEqual([]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    release.resolve(); await pending;
    selected.mockRestore(); timeout.mockRestore(); await f.emit("session_shutdown", {}, f.ctx);
  }
});

test("public Broker read leaves an ordinary native reader's arguments, result and execution budget intact", async () => {
  const f = await fixture(true), adapter = createPiHostAdapter(f.api);
  let executeRead: NativeReadExecutor | undefined;
  adapter.registerReadExecutor = execute => { executeRead = execute; return () => true; };
  await f.install(undefined, {}, adapter);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const input = { path: join(f.ctx.cwd!, "ordinary.txt"), offset: 2, limit: 7, nativeOption: true };
  const output = { content: [{ type: "text" as const, text: "Native-owned output" }], details: { original: true } };
  const nativeTimeout = globalThis.setTimeout;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => nativeTimeout(callback, delay === 60_000 ? 10 : delay, ...args));
  let pending: Promise<unknown> | undefined, settled = false;
  try {
    if (!executeRead) throw new Error("Expected native read boundary");
    pending = executeRead(input, f.ctx, undefined, async actual => { expect(actual).toBe(input); entered.resolve(); await release.promise; return output; }, "ordinary-read")
      .finally(() => { settled = true; });
    await entered.promise; await new Promise(resolve => nativeTimeout(resolve, 25));
    expect(settled).toBe(false);
    release.resolve(); expect(await pending).toBe(output);
    expect(f.calls).toEqual([]); expect(f.persisted).toEqual([]);
  } finally { release.resolve(); await pending; timeout.mockRestore(); await f.emit("session_shutdown", {}, f.ctx); }
});

for (const stop of ["deadline", "abort"] as const)
test(`public Broker fallback read hook settles on ${stop} if native executor ownership is unavailable`, async () => {
  const f = await fixture(true), operation = new AbortController();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.ctx.signal = operation.signal;
  const h = await f.install(async purpose => { entered.resolve(); await release.promise; return [f.graph(purpose)]; });
  await h.host.refresh(f.ctx);
  const nativeTimeout = globalThis.setTimeout;
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
    nativeTimeout(callback, delay === 60_000 && stop === "deadline" ? 15 : delay, ...args));
  const input = { path: f.root.ref! }, original = { ...input };
  const pending = f.emit("tool_call", { toolName: "read", toolCallId: "fallback-read", input }, f.ctx);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await entered.promise;
    if (stop === "abort") operation.abort();
    const result = await Promise.race([pending, new Promise<undefined>(resolve => { watchdog = nativeTimeout(() => resolve(undefined), 100); })]);
    expect(result).toContainEqual(expect.objectContaining({ block: true, admission: expect.objectContaining({
      code: stop === "abort" ? "SOURCE_ACTIVATION_CANCELLED" : "SOURCE_PREPARATION_TIMEOUT", signal_aborted: true,
    }) }));
    expect(input).toEqual(original); expect(f.persisted).toEqual([]);
    release.resolve(); await new Promise(resolve => nativeTimeout(resolve, 0));
    expect(f.persisted).toEqual([]);
    expect(await f.emit("tool_result", { toolName: "read", toolCallId: "fallback-read", input,
      content: [{ type: "text", text: f.root.body! }], isError: false }, f.ctx)).toEqual([undefined]);
  } finally { if (watchdog) clearTimeout(watchdog); release.resolve(); await pending; timeout.mockRestore(); await f.emit("session_shutdown", {}, f.ctx); }
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
  expect(sourceMessageText(inspected.content)).toBe(f.root.body + '\n\n\n<notion-read-status>{"purpose":"inspect","activation_effect":"unchanged","requires_acquisition":"not_performed","use_selection":{"status":"inspection_only","roles":[]}}</notion-read-status>\n\n<notion-effects>{"version":1,"remote_writes":"unknown","author_content":"unknown"}</notion-effects>');
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
  await expect(tool.execute("invalid", { ref: f.root.ref + "&file_id=foreign", refresh: true }, undefined, undefined, f.ctx)).rejects.toThrow();
  expect(f.persisted).toEqual([]);
  const g = await fixture(), tiny = await g.install(async purpose => [{ ...g.graph(purpose), budget: { ...g.graph(purpose).budget, maxContextBytes: 1 } }]);
  await expect(tiny.tool.execute("budget", { ref: g.root.ref, refresh: true }, undefined, undefined, g.ctx)).rejects.toThrow("PREPARE_CONTEXT_BUDGET");
  expect(g.persisted).toEqual([]);
  const observed: ConsumptionEffects = { version: 1, remote_writes: "unknown", author_content: "unchanged" };
  const h = await fixture(), recorded = await h.install(async purpose => [{ ...h.graph(purpose), effects: observed,
    budget: { ...h.graph(purpose).budget, maxContextBytes: 1 } }]);
  await expect(recorded.tool.execute("effects-budget", { ref: h.root.ref }, undefined, undefined, h.ctx)).rejects.toMatchObject({
    details: { effects: { remote_writes: "unknown" } } });
  expect(h.persisted).toEqual([]);
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
  expect(await cancelled).toBeUndefined();
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

async function nativeRead(f: Awaited<ReturnType<typeof fixture>>, reference: string, toolCallId: string, from?: string): Promise<AgentMessage> {
  const input = { path: reference, ...(from === undefined ? {} : { from }) };
  const admission = await f.emit("tool_call", { toolName: "read", toolCallId, input }, f.ctx);
  expect(admission.some(value => value && typeof value === "object" && "block" in value)).toBe(false);
  const content = [{ type: "text" as const, text: await readFile(input.path, "utf8") }];
  const outputs = await f.emit("tool_result", { toolName: "read", toolCallId, input, content, isError: false }, f.ctx);
  const annotated = outputs.find((value): value is { content?: MessageContent; details: unknown } => Boolean(value) && typeof value === "object" && value !== null && "details" in value);
  if (!annotated) throw new Error("Expected the real read hook to return a complete-body receipt");
  return { role: "toolResult", toolName: "read", toolCallId, content: annotated.content ?? content, details: annotated.details, isError: false };
}

function oneRecordGraph(f: Awaited<ReturnType<typeof fixture>>, record: SkillRecord, purpose: PreparationPurpose): PreparedHostGraph {
  const binding = record.preparationBinding!;
  const vector = { version: 1 as const, kind: "observed_version_vector" as const, purpose, scope: binding.scope,
    roots: [record.id!], required: [], bindings: [binding] };
  const validatedAt = Date.now();
  return { ...f.graph(purpose), purpose, roots: vector.roots, bindings: vector.bindings,
    records: [{ ...record, currentObservation: { origin: "remote", validatedAt, validUntil: validatedAt + 60_000 } }],
    lock: { ...vector, sha256: hash(canonical(vector)) }, effects: noConsumptionWrites(),
    usage: { prepared_nodes: 1, instruction_bytes: Buffer.byteLength(record.body!), context_bytes: 4000, max_depth: 0 } };
}

test("an explicit B list returns a usable scoped candidate without changing the current Library A", async () => {
  const a = await fixture(true), b = await fixture(true, false, "pi", "b".repeat(64), false,
    { libraryId: "00000000-0000-4000-8000-000000000099", sourceId: "library-b" });
  const rootA = a.root.locator, rootB = b.root.locator;
  if (rootA?.type !== "shared_skill" || rootB?.type !== "shared_skill") throw new Error("Expected complete owners");
  a.sources[0]!.library = rootA.library_id; b.sources[0]!.library = rootB.library_id; a.sources.push(...b.sources);
  const table = { database_id: rootA.database_id, data_source_id: rootA.data_source_id, property_ids: {} };
  const selection = createLibrarySelection({ sources: a.sources }, async options => ({ version: 2,
    library_id: options.library ?? rootA.library_id, operation_id: "fixture-init", skills: table, files: table, records: table, sources: table }),
  async options => options.library ?? rootA.library_id);
  const metadata = (records: SkillRecord[]) => ({ records: records.map(record => ({ ...record, body: undefined, preparationBinding: undefined })), failures: [] });
  const requests: Array<string | undefined> = [], entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let delay = false;
  const { search, tool, host } = await a.install(async (purpose, _signal, _policy, requested) => {
    expect(requested.map(record => [record.id, record.sourceId, record.sourceScope])).toEqual([[b.root.id, "library-b", b.root.sourceScope]]);
    return [oneRecordGraph(b, b.root, purpose)];
  }, { librarySelection: selection, getRecords: async (_ctx, _signal, _refresh, source) => {
    requests.push(source);
    if (source === "library-b" && delay) { entered.resolve(); await release.promise; }
    return metadata(source === "library-b" ? b.records : a.records);
  }, lookupReference: async () => metadata(a.records), persistGraphs: (graphs, ctx, mode) => persistSessionSelection(a.api, ctx, graphs, mode) });
  await host.refresh(a.ctx);
  const before = sessionSelection(a.ctx);
  const listed = JSON.parse(sourceMessageText((await search.execute("explicit-b", { source: "library-b", query: "root", refresh: true }, undefined, undefined, a.ctx)).content));
  expect(listed.records).toHaveLength(1); expect(listed.records[0].ref).toMatch(/^sr:/);
  expect(requests.at(-1)).toBe("library-b"); expect(a.calls).toEqual([]); expect(a.resourceReads).toEqual([]);
  expect(JSON.stringify(listed)).not.toContain(b.root.body!); expect(sessionSelection(a.ctx)).toEqual(before);
  expect((await selection.selected(a.ctx))?.source.id).toBe("controlled");
  const used = await tool.execute("use-listed-b", { ref: listed.records[0].ref }, undefined, undefined, a.ctx);
  expect(preparationDetails(used)).toMatchObject({ records: [{ binding: { scope: b.root.sourceScope, record: { id: b.root.id, locator: rootB } } }] });
  expect(JSON.parse(sourceMessageText(used.content)).records.map((record: { content: string }) => record.content)).toEqual([b.root.body]);
  expect(sessionSelection(a.ctx).scopes.get(b.root.sourceScope!)?.bindings.get(b.root.id!)).toEqual(b.root.preparationBinding);
  expect((await selection.selected(a.ctx))?.source.id).toBe("controlled");
  const defaults = JSON.parse(sourceMessageText((await search.execute("still-a", { query: "root" }, undefined, undefined, a.ctx)).content));
  expect(defaults.records.map((record: { source: string }) => record.source)).toEqual(["controlled"]);
  delay = true;
  const retired = search.execute("retired-b", { source: "library-b", query: "member", refresh: true }, undefined, undefined, a.ctx).catch(error => error);
  await entered.promise; host.invalidate(); release.resolve();
  expect(await retired).toMatchObject({ code: "SOURCE_ACTIVATION_CANCELLED" });
  await expect(tool.execute("unpublished-b", { ref: b.member.ref }, undefined, undefined, a.ctx)).rejects.toMatchObject({ code: "SOURCE_REFERENCE_MISSING" });
  expect(a.calls).toEqual(["use"]);
});

for (const spelling of ["canonical", "transport-alias"] as const) for (const discovered of [false, true])
test("full-owner use routes A from active B with " + spelling + " and A directory " + discovered, async () => {
  const b = await fixture(true), a = await fixture(true, false, "pi", "b".repeat(64), false,
    { libraryId: "00000000-0000-4000-8000-000000000099", sourceId: "library-a" });
  b.sources.push(...a.sources);
  const resolutions: string[] = [], targets: string[] = [];
  const { tool, host } = await b.install(async (purpose, _signal, _policy, requested) => {
    expect(requested).toHaveLength(1);
    const owner = requested[0]?.sourceId === a.root.sourceId ? a : b;
    expect(requested[0]?.id).toBe(owner.root.id);
    targets.push(owner.root.id!);
    return [oneRecordGraph(owner, owner.root, purpose)];
  }, {
    getRecords: async () => ({ records: discovered ? [...b.records, ...a.records] : b.records, failures: [] }),
    lookupReference: async () => ({ records: b.records, failures: [] }),
    resolveSkillReference: async ref => { resolutions.push(ref); return { ref: a.root.ref!, record: a.root }; },
  });
  await b.emit("input", { source: "rpc", text: "$root task in B" }, b.ctx);
  await host.prepareMany([b.root], b.ctx);
  const ref = spelling === "canonical" ? a.root.id! : a.root.id!.replace("?", "/entrypoint.md/..?");
  const result = await tool.execute("cross-owner-use", { ref }, undefined, undefined, b.ctx);
  expect(targets).toEqual([b.root.id!, a.root.id!]);
  expect(resolutions).toEqual(discovered ? [] : [ref]);
  const body = JSON.parse(sourceMessageText(result.content));
  expect(body.records.map((record: { content: string }) => record.content)).toEqual([a.root.body]);
  expect(preparationDetails(result)).toMatchObject({ records: [
    { binding: { record: { id: a.root.id, locator: a.root.locator }, scope: a.root.sourceScope } },
  ] });
});

test("full-owner lookup rejects a foreign owner or changed established scope before preparation", async () => {
  for (const mismatch of ["owner", "scope"] as const) {
    const b = await fixture(true), a = await fixture(true, false, "pi", "b".repeat(64), false,
      { libraryId: "00000000-0000-4000-8000-000000000099", sourceId: "library-a" });
    b.sources.push(...a.sources);
    const { tool, host } = await b.install(async purpose => [oneRecordGraph(b, b.root, purpose)], {
      getRecords: async () => ({ records: [...b.records, a.member], failures: [] }),
      resolveSkillReference: async () => ({ ref: mismatch === "owner" ? b.root.ref! : a.root.ref!,
        record: mismatch === "owner" ? b.root : { ...a.root, sourceScope: "c".repeat(64) } }),
    });
    await b.emit("input", { source: "rpc", text: "$root task in B" }, b.ctx);
    await host.prepareMany([b.root], b.ctx);
    const entries = structuredClone(b.session.entries);
    await expect(tool.execute("wrong-" + mismatch, { ref: a.root.id! }, undefined, undefined, b.ctx))
      .rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
    expect(b.calls).toEqual(["use"]);
    expect(b.session.entries).toEqual(entries);
  }
});

test("full-owner lookup cannot publish after cancellation, session replacement or a retired generation", async () => {
  for (const change of ["cancel", "session", "generation"] as const) {
    const b = await fixture(true), a = await fixture(true, false, "pi", "b".repeat(64), false,
      { libraryId: "00000000-0000-4000-8000-000000000099", sourceId: "library-a" });
    b.sources.push(...a.sources);
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<{ ref: string; record: SkillRecord }>();
    const controller = new AbortController();
    const { tool, host } = await b.install(undefined, {
      resolveSkillReference: async () => { started.resolve(); return finish.promise; },
    });
    const pending = tool.execute("late-owner", { ref: a.root.id! }, controller.signal, undefined, b.ctx)
      .then(value => ({ value }), error => ({ error }));
    expect(await Promise.race([started.promise.then(() => "started"), pending])).toBe("started");
    if (change === "cancel") controller.abort();
    else if (change === "session") b.session.id = "another-session";
    else host.invalidate();
    finish.resolve({ ref: a.root.ref!, record: a.root });
    expect(await pending).toMatchObject({ error: { code: "SOURCE_ACTIVATION_CANCELLED" } });
    expect(b.calls).toEqual([]); expect(b.persisted).toEqual([]);
  }
});

test("full-owner adoption keeps its authored short target and that target's old pin while B is active", async () => {
  const b = await fixture(true), a = await fixture(true, false, "pi", "b".repeat(64), false,
    { libraryId: "00000000-0000-4000-8000-000000000099", sourceId: "library-a" });
  b.sources.push(...a.sources);
  const old = a.required, current = { ...old, snapshotId: "s_" + hash("new A required"), body: "New A required bytes.\n" };
  persistSessionSelection(b.api, b.ctx, [oneRecordGraph(a, old, "use")], "extend");
  const selected = sessionSelection(b.ctx).scopes.get(a.root.sourceScope!)!.bindings.get(old.id!)!;
  const targets: string[] = [], relative: unknown[] = [];
  const { tool, host } = await b.install(async (purpose, _signal, _policy, requested, pins) => {
    const record = requested[0]!;
    const owner = record.sourceId === a.root.sourceId ? a : b;
    const original = owner.records.find(value => value.id === record.id)!;
    if (record.id === old.id) expect(pins?.get(old.id!)).toBe(old.snapshotId);
    targets.push(record.id!);
    return [oneRecordGraph(owner, original, purpose)];
  }, {
    resolveSkillReference: async (ref, _ctx, _signal, _refresh, sourceId) => {
      const selector = parseNativeReference(ref).selector;
      if (selector === a.root.id) return { ref: a.root.ref!, record: a.root };
      expect(selector).toBe(old.id); expect(sourceId).toBe(a.root.sourceId);
      return { ref, record: current };
    },
    resolveRelativeReference: async (record, from, path) => {
      relative.push({ id: record.id, sourceId: record.sourceId, from, path }); return current.ref!;
    },
    sessionBinding: (record, ctx) => sessionSelection(ctx).scopes.get(record.sourceScope!)?.bindings.get(record.id!),
    persistGraphs: (graphs, ctx, mode) => persistSessionSelection(b.api, ctx, graphs, mode),
  });
  await b.emit("input", { source: "rpc", text: "$root task in B" }, b.ctx);
  await host.prepareMany([b.root], b.ctx);
  await tool.execute("full-A", { ref: a.root.id! }, undefined, undefined, b.ctx);
  const path = "skill://required/SKILL.md";
  const read = await nativeRead(b, path, "authored-short-A", a.root.preparationBinding!.ref);
  expect(relative).toEqual([{ id: a.root.id, sourceId: a.root.sourceId, from: a.root.preparationBinding!.ref, path }]);
  expect(targets).toEqual([b.root.id!, a.root.id!, old.id!]);
  expect(sourceMessageText(read.content)).toStartWith(old.body!);
  expect(sourceMessageText(read.content)).not.toContain(current.body);
  expect(read.details).toMatchObject({ contextBrokerRead: { binding: { record: { id: old.id } }, snapshotId: old.snapshotId } });
  expect(sessionSelection(b.ctx).scopes.get(a.root.sourceScope!)!.bindings.get(old.id!)).toEqual(selected);
});

test("relative read uses the actual fixed containing file and inspects the independently resolved member", async () => {
  const f = await fixture(true), resolved: Array<{ id: string | undefined; from: string; path: string }> = [];
  const h = await f.install(async (purpose, _signal, _policy, requested) => {
    expect(purpose).toBe("inspect");
    const selected = f.records.find(record => record.id === requested[0]?.id);
    if (!selected) throw new Error("Unknown requested owner");
    return [oneRecordGraph(f, selected, purpose)];
  }, { resolveRelativeReference: async (record, from, path, _ctx, _signal, policy) => {
    resolved.push({ id: record.id, from, path }); policy.observeEffects?.(noConsumptionWrites()); return f.member.ref!;
  }, persistGraphs: (graphs, ctx, mode) => persistSessionSelection(f.api, ctx, graphs, mode) });
  await nativeRead(f, f.root.ref!, "containing-main");
  const main = h.host.selectedModelReference(f.root, f.ctx)!;
  const resource = h.host.selectedModelFiles(f.root, f.ctx)!.find(file => file.path === "resources/guide.md")!;
  const originalDirectory = JSON.stringify(f.root.entryManifest);
  const fromMain = await nativeRead(f, "../member/SKILL.md", "from-main", main);
  const fromResource = await nativeRead(f, "../../member/SKILL.md", "from-resource", resource.ref);
  expect(resolved).toEqual([
    { id: f.root.id, from: f.root.preparationBinding!.ref, path: "../member/SKILL.md" },
    { id: f.root.id, from: f.root.entryManifest!.files.find(file => file.path === resource.path)!.ref, path: "../../member/SKILL.md" },
  ]);
  for (const result of [fromMain, fromResource]) {
    expect(sourceMessageText(result.content)).toStartWith(f.member.body!);
    expect(sourceMessageText(result.content)).not.toContain(f.required.body!);
    expect(result.details).toMatchObject({ contextBrokerRead: { binding: { record: { id: f.member.id } }, snapshotId: f.member.snapshotId,
      readStatus: { purpose: "inspect", activation_effect: "unchanged", requires_acquisition: "not_performed" } } });
  }
  expect(f.calls.every(purpose => purpose === "inspect")).toBe(true);
  const inspected = sessionSelection(f.ctx).scopes.get(scope)!;
  expect([...inspected.bindings.keys()].sort()).toEqual([f.root.id!, f.member.id!].sort());
  expect(inspected.graphs.every(graph => graph.purpose === "inspect" && graph.required.length === 0)).toBe(true);
  expect(inspected.bindings.get(f.root.id!)!.snapshot_id).toBe(f.root.snapshotId);
  expect(inspected.bindings.get(f.member.id!)!.snapshot_id).toBe(f.member.snapshotId);
  expect(JSON.stringify(f.root.entryManifest)).toBe(originalDirectory);
});

test("relative read preserves a target's already selected snapshot when its current version changes", async () => {
  for (const discovered of [true, false]) {
    const f = await fixture(true), old = f.member;
    const current = { ...old, snapshotId: "s_" + hash("member current"), versionId: hash("new member bytes"), body: "New member bytes must not be acquired.\n" };
    f.records.splice(f.records.indexOf(old), 1, current);
    persistSessionSelection(f.api, f.ctx, [oneRecordGraph(f, old, "use")], "extend");
    const selectedBefore = sessionSelection(f.ctx).scopes.get(scope)!.bindings.get(old.id!)!;
    const usedBefore = sessionSelection(f.ctx).scopes.get(scope)!.graphs.filter(graph => graph.purpose === "use");
    await f.install(async (purpose, _signal, _policy, requested, pins) => {
      expect(purpose).toBe("inspect"); expect(requested[0]?.id).toBe(old.id);
      expect(pins?.get(old.id!)).toBe(old.snapshotId);
      return [oneRecordGraph(f, old, purpose)];
    }, { resolveRelativeReference: async () => current.ref!,
      ...(!discovered ? { getRecords: async () => ({ records: [f.root], failures: [] }),
        resolveSkillReference: async (ref: string) => ({ ref, record: current }) } : {}),
      sessionBinding: (record, ctx) => sessionSelection(ctx).scopes.get(scope)?.bindings.get(record.id!),
      persistGraphs: (graphs, ctx, mode) => persistSessionSelection(f.api, ctx, graphs, mode) });
    const read = await nativeRead(f, "../member/SKILL.md", "kept-target-version", f.root.preparationBinding!.ref);
    expect(sourceMessageText(read.content)).toStartWith(old.body!);
    expect(sourceMessageText(read.content)).not.toContain(current.body);
    expect(read.details).toMatchObject({ contextBrokerRead: { binding: { record: { id: old.id } }, snapshotId: old.snapshotId } });
    expect(sessionSelection(f.ctx).scopes.get(scope)!.bindings.get(old.id!)).toEqual(selectedBefore);
    expect([...sessionSelection(f.ctx).scopes.get(scope)!.roots]).toEqual([old.id!]);
    expect(sessionSelection(f.ctx).scopes.get(scope)!.graphs.filter(graph => graph.purpose === "use")).toEqual(usedBefore);
  }
});

test("relative lookup stays in its containing configured source and rejects foreign target metadata", async () => {
  for (const foreign of [false, true]) {
    const f = await fixture(true), lookups: unknown[] = [];
    await f.install(async purpose => [oneRecordGraph(f, f.member, purpose)], {
      getRecords: async () => ({ records: [f.root], failures: [] }),
      resolveRelativeReference: async () => f.member.ref!,
      resolveSkillReference: async (ref, _ctx, _signal, refresh, sourceId) => {
        lookups.push({ ref, refresh, sourceId });
        return { ref, record: foreign ? { ...f.member, sourceId: "other-source" } : f.member };
      },
    });
    const input = { path: "../member/SKILL.md", from: f.root.preparationBinding!.ref };
    const result = await f.emit("tool_call", { toolName: "read", toolCallId: "scoped-target", input }, f.ctx);
    expect(lookups).toEqual([{ ref: f.member.ref, refresh: false, sourceId: "controlled" }]);
    if (foreign) { expect(JSON.stringify(result)).toContain("SOURCE_IDENTITY_MISMATCH"); expect(f.calls).toEqual([]); }
    else { expect(input.path).toBe(f.member.path); expect(input).not.toHaveProperty("from"); expect(f.calls).toEqual(["inspect"]); }
  }
});

test("relative Source failures do not guess filesystem paths or prepare another owner", async () => {
  for (const code of ["CURRENT_SOURCE_CHANGED", "CURRENT_SOURCE_REFERENCE_AMBIGUOUS", "CURRENT_SOURCE_EXTERNAL_REFERENCE", "CURRENT_SOURCE_REQUIRED"]) {
    const f = await fixture(true);
    await f.install(undefined, { resolveRelativeReference: async () => { throw new SourceError(code, "controlled"); } });
    const input = { path: "../member/SKILL.md", from: f.root.preparationBinding!.ref }, original = { ...input };
    const results = await f.emit("tool_call", { toolName: "read", toolCallId: code, input }, f.ctx);
    expect(JSON.stringify(results)).toContain(code); expect(input).toEqual(original);
    expect(f.calls).toEqual([]); expect(f.resourceReads).toEqual([]); expect(f.persisted).toEqual([]);
  }
});

test("relative resolution cannot publish a target after cancellation, a session change or a retired generation", async () => {
  for (const change of ["cancel", "session", "generation"] as const) {
    const f = await fixture(true), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<string>();
    const controller = new AbortController(); f.ctx.signal = controller.signal;
    await f.install(undefined, { resolveRelativeReference: async () => { started.resolve(); return finish.promise; } });
    const input = { path: "../member/SKILL.md", from: f.root.preparationBinding!.ref }, original = { ...input };
    const reading = f.emit("tool_call", { toolName: "read", toolCallId: "late-relative", input }, f.ctx);
    await started.promise;
    if (change === "cancel") controller.abort();
    else if (change === "session") f.session.id = "another-session";
    else await f.emit("session_switch", { reason: "new" }, f.ctx);
    finish.resolve(f.member.ref!);
    const results = await reading;
    expect(JSON.stringify(results)).toContain("SOURCE_ACTIVATION_CANCELLED"); expect(input).toEqual(original);
    expect(f.calls).toEqual([]); expect(f.persisted).toEqual([]);
    expect(sessionSelection(f.ctx).scopes.size).toBe(0);
  }
});

test("short-ref directory projection preserves older pins, non-main references and canonical graph locks", async () => {
  const f = await fixture(true), oldPin = "s_" + hash("older root version");
  const relation = (name: string, ref: string) => ({ id: f.root.id!, ref, kind: "skill", name, description: name, availability: "available" });
  const main = f.root.preparationBinding!.ref, resource = f.root.entryManifest!.files.find(file => file.path !== "SKILL.md")!.ref;
  const unchanged = [
    relation("old-pin", withNativeSnapshot(f.root.ref, oldPin)),
    relation("unfixed-resource", f.root.ref!.replace("SKILL.md", "resources/guide.md")),
    relation("unfixed-file-id", f.root.ref + "&file_id=main-root"),
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
  expect(sourceMessageText(shortResource.content)).toBe(f.resourceText.get(f.root.id!) + '\n\n\n<notion-effects>{"version":1,"remote_writes":"unknown","author_content":"unknown"}</notion-effects>');
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
  const refreshed = await tool.execute("refresh-fixed", { ref: fixed, refresh: true }, undefined, undefined, f.ctx);
  expect(preparationDetails(refreshed).purpose).toBe("use");
});

async function auditFixture() {
  const f = await fixture(true);
  const state = { enabled: true, metadataCalls: 0 };
  const h = await f.install(async purpose => {
    if (!state.enabled) throw exactDenial(f.root);
    return [f.graph(purpose)];
  }, { getRecords: async () => {
    state.metadataCalls++;
    return { records: f.records.map(record => ({ ...record, body: undefined, preparationBinding: undefined,
      enabled: record === f.root ? state.enabled : true, defaultDiscovery: record === f.root, currentObservation: { origin: "remote", validatedAt: Date.now(), validUntil: Date.now() + 60_000 } })),
      failures: [], lists: [{ sourceId: "controlled", policy: "default", exhaustive: true }] };
  } });
  await h.host.refresh(f.ctx);
  const list = async (input: Record<string, unknown> = { query: "root" }) => {
    const value = await h.search.execute("audit-list", input, undefined, undefined, f.ctx);
    if (value.content[0]?.type !== "text") throw new Error("Expected list response");
    return JSON.parse(value.content[0].text);
  };
  const disableRead = async () => {
    state.enabled = false;
    await expect(h.host.activate(f.root, f.ctx)).rejects.toMatchObject({ code: "CONTENT_DISABLED" });
    expect((await list()).records[0].availability).toBe("disabled");
  };
  return { ...f, ...h, state, list, disableRead };
}

test("control: known disabled current read is corrected and a successful exact retry recovers", async () => {
  const f = await auditFixture();
  await f.disableRead();f.state.enabled = true;
  await f.host.activate(f.root, f.ctx);
  expect((await f.list()).records[0].availability).toBe("available");
});

test("F1: explicit successful metadata refresh supersedes an older disabled observation", async () => {
  const f = await auditFixture();await f.disableRead();f.state.enabled = true;
  const before = f.state.metadataCalls;f.host.invalidate();await f.host.refresh(f.ctx);
  expect(f.state.metadataCalls).toBe(before + 1);
  expect((await f.list()).records[0].availability).toBe("available");
});

test("F2: a direct notion_use denial updates the same current availability as read", async () => {
  const f = await auditFixture();f.state.enabled = false;
  await expect(f.tool.execute("use-denied", { ref: f.root.ref }, undefined, undefined, f.ctx)).rejects.toMatchObject({ code: "CONTENT_DISABLED" });
  expect((await f.list()).records[0].availability).toBe("disabled");
});

test("F3: a successful notion_use after re-enable retires the prior disabled observation", async () => {
  const f = await auditFixture();await f.disableRead();f.state.enabled = true;
  const result = await f.tool.execute("use-reenabled", { ref: f.root.ref }, undefined, undefined, f.ctx);
  expect(preparationDetails(result).purpose).toBe("use");
  expect((await f.list()).records[0].availability).toBe("available");
});

test("F4: a newly started session does not inherit a previous session's contradicted denial", async () => {
  const f = await auditFixture();await f.disableRead();f.state.enabled = true;
  await f.emit("session_before_switch", {}, f.ctx);f.session.id = "new-session";
  await f.emit("session_start", {}, f.ctx);await f.host.refresh(f.ctx);
  expect((await f.list()).records[0].availability).toBe("available");
});

test("F5: changed advertised availability invalidates an earlier pagination cursor", async () => {
  const f = await auditFixture();const first = await f.list({ limit: 1 });
  expect(first.has_more).toBe(true);expect(typeof first.next_cursor).toBe("string");
  await f.disableRead();
  await expect(f.list({ limit: 1, cursor: first.next_cursor })).rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
});


test("F7: a late older denial cannot overwrite a newer successful current read", async () => {
  const f = await fixture(true);
  const old = Promise.withResolvers<PreparedHostGraph[]>();let attempts = 0;
  const { host, search } = await f.install(async purpose => {
    attempts++;
    return attempts === 1 ? old.promise : [f.graph(purpose)];
  });
  await host.refresh(f.ctx);
  const first = host.activate(f.root, f.ctx, new AbortController().signal).catch(error => error);
  while(attempts !== 1) await new Promise(resolve => setTimeout(resolve,0));
  await host.activate(f.root, f.ctx, new AbortController().signal);
  old.reject(exactDenial(f.root));
  expect(await first).toBeInstanceOf(SourceError);
  const out = await search.execute("after-delayed-denial", { query: "root" }, undefined, undefined, f.ctx);
  if(out.content[0]?.type !== "text") throw new Error("Expected list response");
  expect(JSON.parse(out.content[0].text).records[0].availability).toBe("available");
});


test("F6: list expiry is reached without an editor, warm access does not renew it and concurrent readers coalesce", async () => {
  const f = await fixture(true);let calls = 0;let description = "before-edit";
  const start = Date.now();setSystemTime(start);
  try {
    const h = await f.install(undefined, { getRecords: async () => {
      calls++;const validatedAt = Date.now();
      return { records: f.records.map(record => ({ ...record, description, body: undefined, preparationBinding: undefined,
        currentObservation: { origin: "remote", validatedAt, validUntil: validatedAt + 1000 }, defaultDiscovery: true })), failures: [],
        lists: [{ sourceId: "controlled", policy: "default", exhaustive: true, validatedAt: new Date(validatedAt).toISOString(), ageMs: 0, maxAgeMs: 1000, stale: false }] };
    } });
    await h.host.refresh(f.ctx);const before = calls;
    const list = () => h.search.execute("ttl-list", {}, undefined, undefined, f.ctx);
    description = "after-edit";setSystemTime(start + 999);
    expect(JSON.stringify(await list())).toContain("before-edit");expect(calls).toBe(before);
    setSystemTime(start + 1000);
    const next = await Promise.all([list(),list(),list()]);
    expect(next.every(result => JSON.stringify(result).includes("after-edit"))).toBe(true);
    expect(calls).toBe(before + 1);expect(f.calls).toEqual([]);expect(f.resourceReads).toEqual([]);
    setSystemTime(start + 1999);await list();expect(calls).toBe(before + 1);
    setSystemTime(start + 2000);await list();expect(calls).toBe(before + 2);
  } finally { setSystemTime(); }
});

test("explicit metadata refresh supersedes a blocked cached request and coalesces callers without waiting for retired work", async () => {
  const f = await fixture();
  const old = Promise.withResolvers<void>(), force = Promise.withResolvers<void>();
  const normalStarted = Promise.withResolvers<void>(), forceStarted = Promise.withResolvers<void>();
  let blockNormal = false, forceCalls = 0;
  const data = (description: string) => ({ records: f.records.map(record => ({ ...record, description, body: undefined, preparationBinding: undefined })), failures: [] });
  const h = await f.install(undefined, { getRecords: async (_ctx, _signal, refreshSourceIds) => {
    if (refreshSourceIds?.length) {
      expect(refreshSourceIds).toEqual(["controlled"]); forceCalls++; forceStarted.resolve(); await force.promise;
      return data("current metadata");
    }
    if (blockNormal) { normalStarted.resolve(); await old.promise; return data("retired metadata"); }
    return data("original metadata");
  } });
  await h.host.refresh(f.ctx);
  blockNormal = true;
  const retired = h.host.refresh(f.ctx);
  await normalStarted.promise;
  const cancelled = new AbortController();
  const cancelledRead = h.search.execute("cancelled-waiter", {}, cancelled.signal, undefined, f.ctx).catch(error => error);
  const ordinary = h.search.execute("ordinary-waiter", {}, undefined, undefined, f.ctx);
  const forced = h.search.execute("force-a", { refresh: true }, undefined, undefined, f.ctx);
  await forceStarted.promise;
  const joined = h.search.execute("force-b", { source: "controlled", refresh: true }, undefined, undefined, f.ctx);
  cancelled.abort();
  expect(await cancelledRead).toMatchObject({ code: "SOURCE_ACTIVATION_CANCELLED" });
  force.resolve();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const current = await Promise.race([Promise.all([ordinary, forced, joined]), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Current discovery waited for a retired producer")), 1000);
    })]);
    expect(current.every(result => JSON.stringify(result).includes("current metadata"))).toBe(true);
    expect(forceCalls).toBe(1);
  } finally { clearTimeout(timeout); old.resolve(); await retired; }
  expect(JSON.stringify(await h.search.execute("after-retired", {}, undefined, undefined, f.ctx))).toContain("current metadata");
  expect(f.calls).toEqual([]); expect(f.persisted).toEqual([]); expect(f.resourceReads).toEqual([]);
});

test("explicit refresh unions overlapping source requests and a later session fences their publication", async () => {
  const f = await fixture(); f.sources.push({ id: "other", type: "notion", prefetch: false });
  const pending = Promise.withResolvers<void>();
  const requests: Array<{ sources: readonly string[]; signal: AbortSignal | undefined }> = [];
  let description = "initial";
  const h = await f.install(undefined, { getRecords: async (_ctx, signal, sources) => {
    if (sources?.length) { requests.push({ sources, signal }); await pending.promise; }
    return { records: f.records.map(record => ({ ...record, description: sources ? "retired force" : description, body: undefined, preparationBinding: undefined })), failures: [] };
  } });
  await h.host.refresh(f.ctx);
  const first = h.search.execute("one-source", { source: "controlled", refresh: true }, undefined, undefined, f.ctx).catch(error => error);
  const second = h.search.execute("second-source", { source: "other", refresh: true }, undefined, undefined, f.ctx).catch(error => error);
  expect(requests.map(request => request.sources)).toEqual([["controlled"], ["controlled", "other"]]);
  expect(requests[0]!.signal?.aborted).toBe(true);
  await f.emit("session_before_switch", {}, f.ctx);
  description = "new session metadata";
  await f.emit("session_start", {}, f.ctx);
  pending.resolve();
  for (const result of await Promise.all([first, second])) expect(result).toMatchObject({ code: "SOURCE_ACTIVATION_CANCELLED" });
  expect(JSON.stringify(await h.search.execute("new-session", {}, undefined, undefined, f.ctx))).toContain("new session metadata");
  expect(f.calls).toEqual([]); expect(f.persisted).toEqual([]);
});

test("fresh metadata without a body is not affected by Default Context outside an explicit View filter", async () => {
  for (const enabled of [true,false]) for (const defaultContext of [true,false]) {
    const f = await fixture(true);const {host,search} = await f.install(undefined,{getRecords:async()=>({
      records:[{...f.root,body:undefined,preparationBinding:undefined,enabled,default_context:defaultContext,defaultDiscovery:true}],failures:[],
    })});await host.refresh(f.ctx);
    const result = await search.execute("flag-combination",{},undefined,undefined,f.ctx);
    expect(JSON.stringify(result)).toContain(enabled?'"availability":"available"':'"availability":"disabled"');
    const projection = JSON.stringify(await f.emit("context_with_system",{messages:[{role:"system",content:"Keep native policies"},{role:"user",content:"Show metadata only"}]},f.ctx));
    expect(projection.includes('name=\\"root\\"')).toBe(enabled);
    expect(f.calls).toEqual([]);expect(f.resourceReads).toEqual([]);
  }
});

test("dependency denial changes only the exact child; unproven or foreign failures do not guess root availability", async () => {
  const f = await fixture(true);let error: Error = exactDenial(f.required);
  const {host,tool,search}=await f.install(async()=>{throw error;});await host.refresh(f.ctx);
  await expect(tool.execute("required-denied",{ref:f.root.ref},undefined,undefined,f.ctx)).rejects.toMatchObject({code:"CONTENT_DISABLED"});
  const read = async(query:string)=>JSON.parse(sourceMessageText((await search.execute("scope-check",{query},undefined,undefined,f.ctx)).content));
  expect((await read("root")).records[0].availability).toBe("available");
  expect((await read("required")).records[0].availability).toBe("disabled");
  error=new SourceError("CONTENT_DISABLED","controlled");
  await expect(host.activate(f.root,f.ctx)).rejects.toMatchObject({code:"CONTENT_DISABLED"});
  expect((await read("root")).records[0].availability).toBe("available");
  error=new SourceError("CONTENT_DISABLED","controlled",undefined,{denials:[{scope,id:f.root.id!,ref:f.member.ref!,code:"CONTENT_DISABLED"}]});
  await expect(host.activate(f.root,f.ctx)).rejects.toMatchObject({code:"CONTENT_DISABLED"});
  expect((await read("root")).records[0].availability).toBe("available");
});

test("permission refusal prevents reprojecting a verified old body without rewriting native history", async () => {
  const f=await fixture(true);let denied=false;
  const h=await f.install(async purpose=>{if(denied)throw exactDenial(f.root,"ACCESS_DENIED");return[f.graph(purpose)];});
  await h.host.refresh(f.ctx);
  const loaded=await h.tool.execute("original-use",{ref:f.root.ref},undefined,undefined,f.ctx);
  const messages:AgentMessage[]=[{role:"toolResult",toolName:"notion_use",toolCallId:"original-use",...loaded}];
  const before=JSON.stringify(messages);denied=true;
  await expect(h.host.activate(f.root,f.ctx)).rejects.toMatchObject({code:"ACCESS_DENIED"});
  expect(()=>h.host.assertCanRestore(f.root)).toThrow();
  const projected=await f.emit("context",{messages},f.ctx);
  expect(JSON.stringify(projected)).not.toContain("Exact root");
  expect(JSON.stringify(projected)).toContain("Source access is no longer available");
  expect(JSON.stringify(messages)).toBe(before);
});

test("business disablement permits original fixed restoration but not a new use activation", async () => {
  const f=await fixture(true);let state:"enabled"|"disabled"|"pin"="enabled";
  const h=await f.install(async purpose=>{
    if(state==="disabled")throw exactDenial(f.root);
    const graph=f.graph(purpose);
    return[state==="pin"?{...graph,records:graph.records.map(record=>({...record,currentObservation:undefined}))}:graph];
  });await h.host.refresh(f.ctx);
  const loaded=await h.tool.execute("first-use",{ref:f.root.ref},undefined,undefined,f.ctx);
  const messages:AgentMessage[]=[{role:"toolResult",toolName:"notion_use",toolCallId:"first-use",...loaded}];
  state="disabled";await expect(h.host.activate(f.root,f.ctx)).rejects.toMatchObject({code:"CONTENT_DISABLED"});
    const before=JSON.stringify(messages);await f.emit("context",{messages},f.ctx);expect(JSON.stringify(messages)).toBe(before);
    expect(()=>h.host.assertCanRestore(f.root)).not.toThrow();
  state="pin";
  await expect(h.tool.execute("fixed-use",{ref:f.root.preparationBinding!.ref},undefined,undefined,f.ctx)).rejects.toMatchObject({code:"CONTENT_DISABLED"});
  const list=await h.search.execute("still-disabled",{query:"root"},undefined,undefined,f.ctx);
  expect(sourceMessageText(list.content)).toContain('"availability":"disabled"');
});

test("an older successful read cannot commit after a newer exact denial", async () => {
  const f=await fixture(true),older=Promise.withResolvers<PreparedHostGraph[]>();let attempts=0;
  const h=await f.install(async()=>{attempts++;if(attempts===1)return older.promise;throw exactDenial(f.root);});await h.host.refresh(f.ctx);
  const first=h.host.activate(f.root,f.ctx,new AbortController().signal).catch(error=>error);
  while(attempts!==1)await new Promise(resolve=>setTimeout(resolve,0));
  await expect(h.host.activate(f.root,f.ctx,new AbortController().signal)).rejects.toMatchObject({code:"CONTENT_DISABLED"});
  older.resolve([f.graph("use")]);expect(await first).toMatchObject({code:"CONTENT_DISABLED"});expect(f.persisted).toEqual([]);
});

test("a list completed during an in-flight read is an earlier observation; a following list sees its exact denial", async () => {
  const f=await fixture(true),pending=Promise.withResolvers<PreparedHostGraph[]>();let started=false;
  const h=await f.install(async()=>{started=true;return pending.promise;});await h.host.refresh(f.ctx);
  const read=h.host.activate(f.root,f.ctx,new AbortController().signal).catch(error=>error);
  while(!started)await new Promise(resolve=>setTimeout(resolve,0));
  const list=()=>h.search.execute("observed-order",{query:"root"},undefined,undefined,f.ctx);
  const before=await list();expect(sourceMessageText(before.content)).toContain('"availability":"available"');
  pending.reject(exactDenial(f.root));expect(await read).toMatchObject({code:"CONTENT_DISABLED"});
  expect(sourceMessageText((await list()).content)).toContain('"availability":"disabled"');
  expect(sourceMessageText(before.content)).toContain('"availability":"available"');
});

// Current observations remain conservative across partial failure and later success.
const first: ConsumptionEffects = Object.freeze({ version: 1, remote_writes: "unknown", author_content: "unchanged" });

test("unknown current effects cannot be overwritten by later zero-write observations", () => {
  const original = JSON.stringify(first);
  expect(combineConsumptionEffects([first, noConsumptionWrites()])).toEqual(first);
  expect(combineConsumptionEffects([noConsumptionWrites(), first])).toEqual(first);
  expect(combineConsumptionEffects([first, undefined, noConsumptionWrites()])).toEqual(unknownConsumptionEffects());
  expect(combineConsumptionEffects([first, unknownConsumptionEffects(), noConsumptionWrites()])).toEqual(unknownConsumptionEffects());
  expect(combineConsumptionEffects([noConsumptionWrites(), noConsumptionWrites()])).toEqual(noConsumptionWrites());
  expect(combineConsumptionEffects([])).toEqual(unknownConsumptionEffects());
  expect(JSON.stringify(first)).toBe(original);
});

test("current effects reject old retention receipts, extra fields and incomplete zero-write claims", () => {
  for (const value of [
    undefined, null, {}, { version: 1, remote_writes: "none" },
    { ...noConsumptionWrites(), author_content: "unknown" },
    { ...noConsumptionWrites(), version: 2 },
    { ...noConsumptionWrites(), retention: [] },
    { ...noConsumptionWrites(), remote_writes: "retained", retention: [
      { skill_page_id: "root", file_id: "body", operation_id: "old-operation", status: "confirmed" },
    ] },
    { ...noConsumptionWrites(), extra: true },
  ]) {
    expect(isConsumptionEffects(value)).toBe(false);
    expect(consumptionEffects(value)).toEqual(unknownConsumptionEffects());
  }
  for (const value of [noConsumptionWrites(), first, unknownConsumptionEffects()]) {
    expect(isConsumptionEffects(value)).toBe(true);
    expect(consumptionEffects(value)).toBe(value);
  }
});

test("two current source scopes do not turn an ambiguous canonical ref into a Required role conflict", async () => {
  const f = await fixture(true);
  f.sources.push({ id: "other-source", type: "notion", prefetch: false });
  const other = { ...f.required, sourceId: "other-source", sourceScope: "b".repeat(64), token: "other-required" };
  persistSessionSelection(f.api, f.ctx, [f.graph("use")], "extend");
  const before = sessionSelection(f.ctx), entries = f.session.entries.length;
  const { tool } = await f.install(undefined, { getRecords: async () => ({ records: [...f.records, other].map(record => ({
    ...record, body: undefined, preparationBinding: undefined,
  })), failures: [] }) });
  const result = await tool.execute("ambiguous-refresh", { ref: f.required.ref!, refresh: true }, undefined, undefined, f.ctx).catch(error => error);
  expect(result.code).not.toBe("ROOT_ROLE_CONFLICT");
  expect(result.message).toContain("ambiguous");
  expect(f.calls).toEqual([]);
  expect(f.session.entries.length).toBe(entries);
  expect(sessionSelection(f.ctx)).toEqual(before);
});

test("a unique resolved owner in multiple current scopes still rejects promotion before preparation", async () => {
  const f = await fixture(true);
  f.sources.push({ id: "other-source", type: "notion", prefetch: false });
  const other = { ...f.member, sourceId: "other-source", sourceScope: "b".repeat(64), token: "other-member" };
  persistSessionSelection(f.api, f.ctx, [f.graph("use")], "extend");
  const before = sessionSelection(f.ctx);
  const { tool } = await f.install(undefined, { getRecords: async () => ({ records: [...f.records, other].map(record => ({
    ...record, body: undefined, preparationBinding: undefined,
  })), failures: [] }) });
  const result = await tool.execute("resolved-required-refresh", { ref: f.required.ref!, refresh: true }, undefined, undefined, f.ctx).catch(error => error);
  expect(result.code).toBe("ROOT_ROLE_CONFLICT");
  expect(f.calls).toEqual([]);
  expect(sessionSelection(f.ctx)).toEqual(before);
});


for (const code of ["AUTH_REQUIRED", "ACCESS_DENIED"] as const) for (const boundary of ["source", "scope"] as const)
test(code + " does not taint tracked inspection content in another " + boundary, async () => {
  const f = await fixture(true), other = await fixture(true, false, "pi", boundary === "scope" ? "b".repeat(64) : scope);
  const sourceId = boundary === "source" ? "other-source" : "controlled";
  if (boundary === "source") f.sources.push({ id: sourceId, type: "notion", prefetch: false });
  for (const record of other.records) record.sourceId = sourceId;
  let showingOther = true, deny = false;
  const { host } = await f.install(async purpose => {
    if (deny) {
      if (code === "AUTH_REQUIRED") throw new SourceError(code, "controlled");
      if (f.root.locator?.type !== "shared_skill") throw new Error("Expected physical shared owner");
      throw exactDenial({ ...f.root, ref: "https://www.notion.so/" + f.root.locator.page_id.replaceAll("-", "") }, code);
    }
    return [{ ...(showingOther ? other : f).graph(purpose), sourceId: showingOther ? sourceId : "controlled" }];
  }, { getRecords: async () => ({ records: (showingOther ? other : f).records.map(record => ({
    ...record, body: undefined, preparationBinding: undefined,
  })), failures: [] }) });
  await host.refresh(f.ctx);
  expect(sourceMessageText((await nativeRead(f, other.root.ref!, "other-inspection")).content)).toContain(other.root.body!);
  showingOther = false;
  await host.refresh(f.ctx);
  deny = true;
  const admission = await f.emit("tool_call", { toolName: "read", toolCallId: "denied-current-source", input: { path: f.root.ref!, refresh: true } }, f.ctx);
  expect(admission).toContainEqual(expect.objectContaining({ block: true, admission: expect.objectContaining({ code }) }));
  expect(() => host.assertCanRestore(f.root)).toThrow(code);
  showingOther = true; deny = false;
  await host.refresh(f.ctx);
  // Metadata contains no new currentObservation. This checks the original
  // scoped denial, without a successful body acquisition clearing it first.
  expect(() => host.assertCanRestore(other.root)).not.toThrow();
});

for (const acquisition of ["use", "main read", "resource read"] as const)
test(`a fresh verified ${acquisition} recovers after a Pi preparation failure without reviving retired source messages`, async () => {
  const f = await fixture(true), operation = new AbortController();
  const user: AgentMessage = { role: "user", content: [{ type: "text", text: "$root explain my task" }] };
  const old: AgentMessage = { role: "toolResult", toolName: "notion_use", toolCallId: "retired-result",
    content: [{ type: "text", text: "Old failed source instructions" }] };
  let restorations = 0, confirmations = 0, refuse = false;
  f.ctx.signal = operation.signal;
  f.ctx.model = { api: "openai-responses", baseUrl: "http://127.0.0.1:8989/v1" };
  const h = await f.install(async purpose => {
    if (refuse) throw new SourceError("AUTH_REQUIRED", "controlled");
    return [f.graph(purpose)];
  }, {
    restoreActive: async messages => {
      if (++restorations === 1) throw Object.assign(new Error("Skill preparation timed out"), { code: "SOURCE_PREPARATION_TIMEOUT" });
      return { messages, restored: [], notices: [] };
    },
    confirmDelivery() { confirmations++; },
  });
  const context = async (messages: AgentMessage[]) => {
    const [result] = await f.emit("context", { messages }, f.ctx);
    if (!result || typeof result !== "object" || !("messages" in result) || !Array.isArray(result.messages))
      throw new Error("Expected a context result");
    return result.messages as AgentMessage[];
  };
  try {
    await h.host.refresh(f.ctx);
    await f.emit("input", { source: "rpc", text: sourceMessageText(user.content) }, f.ctx);
    await f.emit("before_agent_start", { prompt: sourceMessageText(user.content), systemPrompt: "base" }, f.ctx);
    await f.emit("agent_start", {}, f.ctx);
    const initial = await context([user, old]);
    expect(JSON.stringify(initial)).toContain("SOURCE_PREPARATION_TIMEOUT");
    expect(JSON.stringify(initial)).not.toContain("Old failed source instructions");
    expect(confirmations).toBe(0);
    const lateInput = { path: f.root.ref! };
    if (acquisition === "use") {
      const admission = await f.emit("tool_call", { toolName: "read", toolCallId: "late-read", input: lateInput }, f.ctx);
      expect(admission.some(value => value && typeof value === "object" && "block" in value)).toBe(false);
    }
    const toolCallId = "fresh-result";
    const fresh: AgentMessage = acquisition === "use"
      ? { role: "toolResult", toolName: "notion_use", toolCallId,
        ...await h.tool.execute(toolCallId, { ref: f.root.ref }, operation.signal, undefined, f.ctx) }
      : await nativeRead(f, acquisition === "main read" ? f.root.ref!
        : f.root.entryManifest!.files.find(file => file.path === "resources/guide.md")!.ref, toolCallId);
    if (acquisition === "use") {
      const changed = { ...fresh, content: [{ type: "text" as const, text: "Unverified replacement instructions" }] };
      const withheld = await context([user, old, changed]);
      expect(withheld.find(message => message.toolCallId === toolCallId)).toMatchObject({ isError: true });
      expect(JSON.stringify(withheld)).not.toContain("Unverified replacement instructions");
    }
    const recovered = await context([user, old, fresh]);
    const expectedRestorations = acquisition === "use" ? 3 : 2;
    expect(restorations).toBe(expectedRestorations);
    expect(recovered.find(message => message.toolCallId === toolCallId)).toEqual(fresh);
    expect(Array.isArray(recovered.find(message => message.toolCallId === old.toolCallId)?.content)).toBe(true);
    expect(JSON.stringify(recovered)).not.toContain("Old failed source instructions");
    expect(JSON.stringify(recovered)).not.toContain("SOURCE_PREPARATION_TIMEOUT");
    if (acquisition === "use") {
      expect(sourceBodyLoaded(recovered, f.root)).toBe(true);
      expect(sourceBodyLoaded(recovered, f.required)).toBe(true);
    } else expect(sourceMessageText(fresh.content)).toContain(acquisition === "main read" ? f.root.body! : f.resourceText.get(f.root.id!)!);
    const payload = { input: recovered.map(message => message.role === "toolResult"
      ? { type: "function_call_output", call_id: message.toolCallId, output: sourceMessageText(message.content) }
      : { role: "user", content: sourceMessageText(message.content) }) };
    expect(await f.emit("before_provider_request", { type: "before_provider_request", payload }, f.ctx)).toEqual([undefined]);
    expect(confirmations).toBe(0);
    await f.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, f.ctx);
    expect(confirmations).toBe(1);
    expect(operation.signal.aborted).toBe(false);
    if (acquisition === "use") {
      // A later host projection drops Requires after the complete context was
      // captured. Recovery must still cross the original delivery guard.
      const broken = recovered.map(message => message.toolCallId === toolCallId ? { ...message,
        content: [{ type: "text" as const, text: sourceMessageText(message.content).replace(JSON.stringify(f.required.body!).slice(1, -1), "truncated") }] } : message);
      await f.emit("context_with_system", { messages: [{ role: "system", content: "base" }, ...broken] }, f.ctx);
      const [safe] = await f.emit("before_provider_request", { type: "before_provider_request", payload }, f.ctx);
      expect(JSON.stringify(safe)).toContain("SOURCE_CONTEXT_CLOSURE_INCOMPLETE");
      expect(JSON.stringify(safe)).not.toContain("Exact root");
      await f.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, f.ctx);
      expect(confirmations).toBe(1);
      // This main read was authorized in the previous failure episode. Its late
      // complete receipt must not reopen the newer failed episode.
      const content = [{ type: "text" as const, text: await readFile(lateInput.path, "utf8") }];
      const [late] = await f.emit("tool_result", { toolName: "read", toolCallId: "late-read", input: lateInput, content, isError: false }, f.ctx);
      if (!late || typeof late !== "object") throw new Error("Expected a complete late read result");
      expect(late).toMatchObject({ details: { contextBrokerRead: { toolCallId: "late-read" } } });
      const continued = await context([user, old, fresh, { role: "toolResult", toolName: "read", toolCallId: "late-read", content, ...late }]);
      expect(restorations).toBe(expectedRestorations);
      expect(JSON.stringify(continued)).not.toContain("Exact root");
      expect(continued.every(message => message.role !== "toolResult" || Array.isArray(message.content))).toBe(true);
      const partialInput = { path: f.root.entryManifest!.files.find(file => file.path === "resources/guide.md")!.ref };
      await f.emit("tool_call", { toolName: "read", toolCallId: "partial-resource", input: partialInput }, f.ctx);
      const partialContent = [{ type: "text" as const, text: (await readFile(partialInput.path, "utf8")).slice(0, 5) }];
      const [partial] = await f.emit("tool_result", { toolName: "read", toolCallId: "partial-resource", input: partialInput, content: partialContent, isError: false }, f.ctx);
      expect(partial).toMatchObject({ details: { contextBrokerResource: { delivered_complete_text: false } } });
      await context([user, fresh]);
      expect(restorations).toBe(expectedRestorations);
      refuse = true;
      await expect(h.tool.execute("denied-recovery", { ref: f.root.ref }, operation.signal, undefined, f.ctx)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      expect(JSON.stringify(await context([user, old, fresh]))).not.toContain("Exact root");
      expect(confirmations).toBe(1);
    }
  } finally { await f.emit("agent_end", {}, f.ctx); await f.emit("session_shutdown", {}, f.ctx); }
});

for (const suspended of ["print metadata", "active restoration"] as const)
test(`the whole Pi context deadline bounds a suspended ${suspended} producer without cancelling the user`, async () => {
  const f = await fixture(true), operation = new AbortController();
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>();
  const notices: Array<{ text: string; level?: string }> = [];
  let aborts = 0, confirmations = 0, restorationSignal: AbortSignal | undefined;
  const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" };
  const text = "$root explain my question and this attached image.";
  const user: AgentMessage = { role: "user", content: [{ type: "text", text }, image] };
  const messages = [user], original = JSON.stringify(messages);
  f.ctx.mode = suspended === "print metadata" ? "print" : "rpc";
  f.ctx.signal = operation.signal;
  f.ctx.model = { api: "openai-completions", baseUrl: "http://127.0.0.1:8989/v1" };
  f.ctx.abort = () => { aborts++; operation.abort(); };
  f.ctx.ui = { notify(text, level) { notices.push({ text, level }); } };
  const h = await f.install(undefined, {
    ...(suspended === "print metadata" ? { getRecords: async () => {
      entered.resolve();
      // This producer deliberately ignores cancellation and remains unresolved
      // until after the host deadline has already allowed the user to continue.
      await finish.promise; completed.resolve();
      return { records: f.records.map(record => ({ ...record, body: undefined, preparationBinding: undefined })), failures: [] };
    } } : { restoreActive: async (current: AgentMessage[], _ctx: ExtensionContext, signal: AbortSignal) => {
      restorationSignal = signal; entered.resolve();
      await finish.promise; completed.resolve();
      return { messages: current, restored: [{ customType: "context-broker", content: f.root.body!, display: false,
        details: { records: [sourceDeliveryReceipt(f.root, f.root.body!)] } }], notices: [] };
    } }),
    buildPreparedPrompt: async (_text, _ctx, _signal, records = []) => {
      const content = records.map(record => record.body!).join("\n\n");
      return { customType: "context-broker", content, display: false,
        details: { records: records.map(record => sourceDeliveryReceipt(record, content)) } };
    },
    confirmDelivery() { confirmations++; },
  });
  if (suspended === "active restoration") await h.host.refresh(f.ctx);
  const nativeTimeout = globalThis.setTimeout, deadlines: number[] = [];
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
    if (delay === 60_000) deadlines.push(delay);
    return nativeTimeout(callback, delay === 60_000 ? 20 : delay, ...args);
  });
  let pending: Promise<unknown[]> | undefined;
  try {
    expect(await f.emit("input", { source: "rpc", text, images: [image] }, f.ctx)).toEqual([{ action: "continue" }]);
    await f.emit("before_agent_start", { prompt: text, systemPrompt: "base" }, f.ctx);
    await f.emit("agent_start", {}, f.ctx);
    pending = f.emit("context", { messages }, f.ctx);
    await entered.promise;
    const [output] = await pending;
    if (!output || typeof output !== "object" || !("messages" in output) || !Array.isArray(output.messages))
      throw new Error("Expected a nonblocking context result");
    expect(deadlines).toEqual([60_000]);
    expect(output.messages).toContainEqual(user);
    expect(JSON.stringify(output)).toContain("SOURCE_PREPARATION_TIMEOUT");
    expect(JSON.stringify(output)).not.toContain("Exact root"); expect(JSON.stringify(output)).not.toContain("Exact required");
    expect(notices.some(notice => notice.level === "warning" && notice.text.includes("SOURCE_PREPARATION_TIMEOUT"))).toBe(true);
    expect(operation.signal.aborted).toBe(false); expect(aborts).toBe(0);
    expect(f.calls).toEqual(suspended === "print metadata" ? [] : ["use"]);
    if (suspended === "active restoration") expect(restorationSignal?.aborted).toBe(true);
    const providerUser = { role: "user", content: [{ type: "text", text },
      { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }] };
    const payload = { messages: [providerUser, ...output.messages.filter(message => message.role !== "user")
      .map(message => ({ role: "user", content: sourceMessageText(message.content) }))] };
    const [sent] = await f.emit("before_provider_request", { type: "before_provider_request", payload }, f.ctx);
    if (!sent || typeof sent !== "object" || !("messages" in sent) || !Array.isArray(sent.messages))
      throw new Error("Expected a nonblocking provider payload");
    expect(sent.messages.filter(message => JSON.stringify(message) === JSON.stringify(providerUser))).toHaveLength(1);
    expect(JSON.stringify(sent)).toContain("SOURCE_PREPARATION_TIMEOUT");
    expect(JSON.stringify(sent)).not.toContain("Exact root"); expect(JSON.stringify(sent)).not.toContain("Exact required");
    await f.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} }, f.ctx);
    expect(f.persisted).toEqual([]); expect(confirmations).toBe(0);
    const frozen = JSON.stringify(output);
    finish.resolve(); await completed.promise;
    await new Promise(resolve => nativeTimeout(resolve, 0));
    const [later] = await f.emit("context", { messages }, f.ctx);
    expect(JSON.stringify(later)).not.toContain("Exact root"); expect(JSON.stringify(later)).not.toContain("Exact required");
    expect(JSON.stringify(output)).toBe(frozen); expect(JSON.stringify(messages)).toBe(original);
    expect(f.persisted).toEqual([]); expect(confirmations).toBe(0); expect(aborts).toBe(0);
    expect(f.session.entries.some(entry => entry.type === "custom"
      && ["context-broker-selected-graph", "context-broker-active-sources"].includes(entry.customType))).toBe(false);
  } finally {
    finish.resolve(); await pending?.catch(() => undefined);
    timeout.mockRestore();
    await f.emit("agent_end", {}, f.ctx); await f.emit("session_shutdown", {}, f.ctx);
  }
});
