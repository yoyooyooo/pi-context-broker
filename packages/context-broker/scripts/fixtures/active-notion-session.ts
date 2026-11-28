import { nativeFileRef, nativeSkillId, withNativeSnapshot, bindNativeReference } from "../../src/native-reference";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { currentNotionFixture } from "./current-notion-source";
import { noConsumptionWrites } from "../../src/consumption-effects";
import { parseNativeReference } from "../../src/native-reference";
import type { PreparedHostGraph } from "../../src/prepare-protocol";
import type { AgentMessage, ContentRecord, ExtensionAPI, ExtensionContext, ImageContent, SessionEntry, SkillRecord } from "../../src/types";

type ProviderPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ProviderPayload = { messages: Array<{ role: string; content: string | ProviderPart[]; tool_call_id?: string }> };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function providerPart(value: unknown): value is ProviderPart {
  return object(value) && (value.type === "text" && typeof value.text === "string"
    || value.type === "image_url" && object(value.image_url) && typeof value.image_url.url === "string");
}
function providerPayload(value: unknown): value is ProviderPayload {
  if (!object(value) || !Array.isArray(value.messages)) return false;
  const messages: unknown[] = value.messages;
  return messages.every(message => object(message) && typeof message.role === "string"
    && (typeof message.content === "string" || Array.isArray(message.content) && message.content.every(providerPart))
    && (message.tool_call_id === undefined || typeof message.tool_call_id === "string"));
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
const environmentKeys = ["CONTEXT_BROKER_CONFIG", "CONTEXT_BROKER_ROOTS", "CONTEXT_BROKER_EXTRA_ROOTS",
  "CONTEXT_BROKER_DISCOVERY_CATALOGS", "CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS", "CONTEXT_BROKER_HOST"];

/** Production index, adapter, graph decoder and delivery hooks. Only the external
 * SDK and Pi session manager are controlled; this is not a live Pi/Notion test. */
export async function activeNotionSession(options: { catalogMaxAgeMs?: number; sourceScope?: string; sourceEnabled?: boolean;
  warmCatalog?: boolean; beforeStart?(fixture: Awaited<ReturnType<typeof currentNotionFixture>>): void } = {}) {
  const f = await currentNotionFixture("skill", { name: "root", body: "Complete root instructions A.\n" });
  if (options.sourceEnabled !== undefined) f.source.enabled = options.sourceEnabled;
  const scope = options.sourceScope ?? f.selected.sourceScope;
  assert.ok(scope);
  assert.equal(f.record.locator.type, "shared_skill");
  const records = new Map<string, SkillRecord>();
  for (const [index, name] of ["root", "required", "second", "independent"].entries()) {
    const id = index === 0 ? f.record.id : nativeSkillId("00000000-0000-4000-8000-000000000099", String(name));
    const metadata: ContentRecord = { ...f.record, id, name, alias: name, description: name,
      ref: nativeFileRef(id, "SKILL.md"), locator: { ...f.record.locator,
        skill_id: index === 0 ? "entry" : name, page_id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0") } };
    const body = "Complete " + name + " instructions A.\n", snapshotId = "s_" + hash(name);
    records.set(name, { ...f.selected, ...metadata, sourceScope: scope, body, snapshotId, versionId: hash(body), normalizedName: name,
      path: join(f.root, name, "SKILL.md"), fileBindings: [{ file_id: "main-" + name, page_id: metadata.locator.page_id, path: metadata.entrypoint }], preparationBinding: { record: metadata, scope, snapshot_id: snapshotId,
        version_id: hash(body), body_sha256: hash(body), ref: withNativeSnapshot(metadata.ref, snapshotId) } });
  }
  const record = (name: string) => { const found = records.get(name); assert.ok(found); return found; };
  const versions = new Map([...records.values()].map(item => [item.snapshotId!, item]));
  const requirements = new Map([...records.values()].map(item => [item.snapshotId!, item.name === "root" || item.name === "second" ? [record("required")] : []]));
  const required = (owner: SkillRecord) => requirements.get(owner.snapshotId!) ?? [];
  type Input = Parameters<typeof f.result>[0];
  const ready = (input: Input) => {
    const roots = input.targets.map(target => {
      const ref = bindNativeReference(parseNativeReference(target), "00000000-0000-4000-8000-000000000099");
      const found = ref.snapshot ? versions.get(ref.snapshot) : [...records.values()].find(item => item.id === ref.selector);
      assert.ok(found); assert.equal(found.id, ref.selector); return found;
    });
    // Current relation observations may change while the root's original bytes
    // and fixed binding stay identical. Historical targets keep their old graph.
    const currentRoots = new Set(roots.filter((_, index) => !parseNativeReference(input.targets[index]!).snapshot).map(item => item.id));
    const requiredFor = (owner: SkillRecord) => currentRoots.has(owner.id) && (owner.name === "root" || owner.name === "second")
      ? [record("required")] : required(owner);
    const selected = new Map(roots.map(item => [item.id, item]));
    if (input.purpose === "use") for (const item of roots) for (const child of requiredFor(item)) selected.set(child.id, child);
    const nodes = [...selected.values()].map(item => {
      const binding = item.preparationBinding!;
      const relations = { required: requiredFor(item).map(child => ({ id: child.id!, ref: child.ref!, kind: "skill", name: child.name,
        description: child.description!, availability: "available" })), candidates: [], references: [], unresolved_references: [] };
      const files = [{ path: item.entrypoint!, bytes: Buffer.byteLength(item.body!), sha256: binding.body_sha256, ref: binding.ref }];
      const fixed = input.targets.some(target => parseNativeReference(target).selector === item.id && parseNativeReference(target).snapshot);
      return { state: "prepared", id: item.id!, ref: binding.ref, roles: roots.includes(item) ? ["root"] : ["required"], kind: "skill",
        record: binding.record, binding, path: item.entrypoint!, content: item.body!, bytes: files[0]!.bytes, body_sha256: binding.body_sha256,
        files, ...relations, source: fixed ? "local_snapshot" : "notion",
        freshness: fixed ? { policy: "pinned" } : { policy: "refresh", validated_at: new Date().toISOString(), age_ms: 0, max_age_ms: 1000, stale: false } };
    });
    const edges = [...selected.values()].flatMap(item => requiredFor(item).map(child => ({ from: item.id!, to: child.id!, ref: child.preparationBinding!.ref })));
    const vector = { version: 1, kind: "observed_version_vector", purpose: input.purpose, scope, roots: roots.map(item => item.id!).sort(),
      required: edges, bindings: nodes.map(node => node.binding) };
    const bytes = nodes.reduce((sum, node) => sum + node.bytes, 0);
    return { version: 1, status: "ready", effects: noConsumptionWrites(), preparation: {
      version: 1, status: "ready", purpose: input.purpose, scope,
      roots: roots.map((item, index) => ({ target: input.targets[index], id: item.id!, ref: item.preparationBinding!.ref, readiness: "ready" })),
      nodes, required: edges, required_closure: input.purpose === "use" ? nodes.map(node => node.id) : [],
      session_bindings: vector.bindings, graph_lock: { ...vector, sha256: hash(canonical(vector)) },
      budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144, ...input.budget },
      usage: { prepared_nodes: nodes.length, instruction_bytes: bytes, context_bytes: bytes, max_depth: input.purpose === "use" && edges.length ? 1 : 0 },
    }, entries: nodes.map(node => {
      const manifest = { complete: true, scope, snapshot_id: node.binding.snapshot_id, version_id: node.binding.version_id,
        record: node.record, entrypoint: node.path, files: node.files.map(({ ref: _ref, ...file }) => file), file_bindings: selected.get(node.id)!.fileBindings };
      const relations = { required: node.required, candidates: node.candidates, references: node.references, unresolved_references: node.unresolved_references };
      return { id: node.id, manifest, manifest_sha256: hash(canonical(manifest)), source_body: { kind: "verified_snapshot_entry",
        ref: node.ref, path: node.path, bytes: node.bytes, sha256: node.body_sha256,
        range: { start: 1, end: node.content.split("\n").length, total_lines: node.content.split("\n").length }, has_more: false },
        materialization: { status: "entry_ready", paths: [node.path] }, projection: { status: "identity", compiler: "source-identity/v1",
          source_body_sha256: node.body_sha256, relations_sha256: hash(canonical(relations)), projection_sha256: node.body_sha256, bytes: node.bytes } };
    }), export: { status: "not_requested" }, delivery: { status: "not_observed" }, activation: { status: "not_evaluated" } };
  };
  f.state.consume = async input => ready(input);
  f.state.catalog = { ...f.state.catalog, scope, records: [...records.values()].map(item => item.preparationBinding!.record), count: records.size,
    freshness: { policy: "max_age", validated_at: new Date().toISOString(), age_ms: 0, max_age_ms: options.catalogMaxAgeMs ?? 1_000_000, stale: false } };
  f.state.directory = { ...f.state.catalog, records: [], count: 0, view: null, view_selection: "none" };
  f.state.resolve = (target, catalog) => {
    const ref = bindNativeReference(parseNativeReference(target), "00000000-0000-4000-8000-000000000099");
    const rows = (catalog as typeof f.state.catalog).records;
    const row = rows.find(item => item.id === ref.selector);
    if (!row) throw Object.assign(new Error("Exact ID unavailable"), { code: "SKILL_NOT_FOUND" });
    return { record: row, scope, ref: nativeFileRef(row.id, ref.path || row.entrypoint) };
  };
  const revise = (name: string, body: string, entrypoint = record(name).entrypoint!) => {
    const previous = record(name), metadata = { ...previous.preparationBinding!.record, entrypoint,
      ref: nativeFileRef(previous.id!, entrypoint) };
    const snapshotId = "s_" + hash(name + body + entrypoint), next = { ...previous, ...metadata, body, snapshotId, versionId: hash(body),
      path: join(f.root, name, entrypoint), fileBindings: previous.fileBindings?.map(binding => ({ ...binding, path: entrypoint })), preparationBinding: { record: metadata, scope, snapshot_id: snapshotId,
        version_id: hash(body), body_sha256: hash(body), ref: withNativeSnapshot(metadata.ref, snapshotId) } };
    records.set(name, next); versions.set(snapshotId, next);
    requirements.set(snapshotId, name === "root" || name === "second" ? [record("required")] : []);
    f.state.catalog = { ...f.state.catalog, records: [...records.values()].map(item => item.preparationBinding!.record) };
    return next;
  };
  const previous = new Map(environmentKeys.map(key => [key, process.env[key]]));
  const config = join(f.root, "config.json");
  await writeFile(config, JSON.stringify({ skillRoots: [], sources: [f.source] }));
  for (const key of environmentKeys) delete process.env[key];
  process.env.CONTEXT_BROKER_CONFIG = config; process.env.CONTEXT_BROKER_HOST = "pi";
  const moduleAt = (name: string) => pathToFileURL(join(f.root, "src", name + ".ts")).href;
  const { default: contextBroker }: typeof import("../../src/index") = await import(moduleAt("index"));
  const { persistSessionSelection, sessionSelection }: typeof import("../../src/session-graph") = await import(moduleAt("session-graph"));
  const { createSessionShortRefHost }: typeof import("../../src/session-short-ref-host") = await import(moduleAt("session-short-ref-host"));
  const { confirmActiveSources, activeSources }: typeof import("../../src/session-active") = await import(moduleAt("session-active"));
  const { sourceDeliveryReceipt, sourceMessageText }: typeof import("../../src/session-source-snapshot") = await import(moduleAt("session-source-snapshot"));
  const handlers = new Map<string, Array<(event: never, context: ExtensionContext) => unknown>>();
  const commands = new Map<string, Parameters<NonNullable<ExtensionAPI["registerCommand"]>>[1]>();
  const tools: Parameters<NonNullable<ExtensionAPI["registerTool"]>>[0][] = [], branch: SessionEntry[] = [];
  let visible: AgentMessage[] = [], controller = new AbortController(), aborts = 0;
  const notices: Array<{ text: string; level?: string }> = [];
  const api: ExtensionAPI = {
    on(name, handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool(tool) { tools.push(tool); }, registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) { branch.push({ type: "custom", customType, data, id: "entry-" + branch.length }); },
    getActiveTools: () => ["read", "notion_list", "notion_use"],
  };
  const ctx: ExtensionContext = { cwd: f.root, mode: "rpc", signal: controller.signal,
    model: { api: "openai-completions", baseUrl: "http://127.0.0.1:8989/v1" }, abort() { aborts++; controller.abort(); }, getSystemPrompt: () => "",
    ui: { notify(text, level) { notices.push({ text, level }); } },
    sessionManager: { getBranch: () => branch, getSessionId: () => "recovery-session", getSessionFile: () => join(f.root, "session.jsonl"),
      buildSessionContext: () => ({ messages: visible }), buildSessionProjection: () => ({ messages: visible, entries: [] }) } };
  const emit = async (name: string, event: unknown = {}) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event as never, ctx));
    return results;
  };
  const tool = (name: "notion_list" | "notion_use" | "notion_ctl") => { const found = tools.find(item => item.name === name); assert.ok(found); return found; };
  const delivered = (items: readonly SkillRecord[]): AgentMessage[] => items.map(item => ({ role: "custom", customType: "context-broker", content: item.body,
    details: { records: [sourceDeliveryReceipt(item, item.body!)] } }));
  options.beforeStart?.(f);
  await contextBroker(api);
  await emit("session_start");
  if (options.sourceEnabled !== false && options.warmCatalog !== false) await tool("notion_list").execute("catalog", {}, undefined, undefined, ctx);
  const seed = async (roots = ["root"]) => {
    const graph: PreparedHostGraph = await f.boundary.prepareNotionSkills(roots.map(record), f.source, f.root, { purpose: "use" });
    persistSessionSelection(api, ctx, [graph], "extend");
    confirmActiveSources(api, ctx, graph.records, delivered(graph.records));
    return graph;
  };
  const seedLocal = () => {
    const record: SkillRecord = { name: "local", kind: "skill", source: "filesystem", sourceId: "local", path: join(f.root, "local", "SKILL.md"),
      body: "Independent local instructions.\n", aliases: [], normalizedName: "local", normalizedAliases: [], normalizedDescription: "local", autoloadEnabled: false };
    confirmActiveSources(api, ctx, [record], delivered([record]));
    return record;
  };
  const turn = async (text: string, bodies: readonly SkillRecord[] = [], beforeProvider?: (payload: ProviderPayload) => Promise<void> | void,
    beforeFinalContext?: (messages: AgentMessage[]) => AgentMessage[], previousMessages: readonly AgentMessage[] = [],
    delivery: { beforeContext?(): Promise<AgentMessage[]>; status?: number; images?: ImageContent[] } = {}) => {
    controller = new AbortController(); ctx.signal = controller.signal;
    const beforeAborts = aborts, beforeCalls = f.calls.length, beforeNotices = notices.length;
    const input = await emit("input", { source: "rpc", text, images: delivery.images });
    await emit("before_agent_start", { prompt: text, systemPrompt: "Current recovery test." });
    await emit("agent_start");
    visible = [{ role: "system", content: "Current recovery test." },
      { role: "user", content: delivery.images?.length ? [{ type: "text", text }, ...delivery.images] : text }, ...delivered(bodies), ...previousMessages];
    let messages = visible, error: unknown, provider = false;
    let payload: ProviderPayload | undefined;
    try {
      if (delivery.beforeContext) { visible.push(...await delivery.beforeContext()); messages = visible; }
      for (const name of ["context", "context_with_system"]) {
        if (name === "context_with_system" && beforeFinalContext) messages = beforeFinalContext(messages);
        for (const handler of handlers.get(name) ?? []) {
          const result = await handler({ messages } as never, ctx);
          if (result && typeof result === "object" && "messages" in result && Array.isArray(result.messages)) messages = result.messages;
        }
      }
      payload = { messages: messages.map(message => {
        const content = Array.isArray(message.content) && message.content.some(part => part.type === "image")
          ? message.content.map((part): ProviderPart => {
            if (part.type === "text") return { type: "text", text: part.text };
            assert.equal(typeof part.mimeType, "string"); assert.equal(typeof part.data, "string");
            return { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
          }) : sourceMessageText(message.content);
        return { role: message.role === "custom" ? "user" : message.role === "toolResult" ? "tool" : message.role,
          content, ...(message.role === "toolResult" ? { tool_call_id: message.toolCallId } : {}) };
      }) };
      await beforeProvider?.(payload);
      // Pi chains each returned payload into the next handler and sends the final
      // value. Ignoring the return would hide a broken nonblocking replacement.
      for (const handler of handlers.get("before_provider_request") ?? []) {
        const result = await handler({ type: "before_provider_request", payload } as never, ctx);
        if (result !== undefined) { assert.ok(providerPayload(result), "Provider hook returned an invalid payload"); payload = result; }
      }
      provider = !controller.signal.aborted;
      if (provider && delivery.status !== undefined) await emit("after_provider_response", { type: "after_provider_response", status: delivery.status, headers: {} });
    } catch (cause) { error = cause; }
    await emit("agent_end");
    return { input, messages, payload, error, provider, aborted: controller.signal.aborted, aborts: aborts - beforeAborts,
      calls: f.calls.slice(beforeCalls).filter(call => call.operation === "consume"), notices: notices.slice(beforeNotices), active: activeSources(ctx) };
  };
  const close = async () => {
    try { await emit("session_shutdown"); }
    finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  };
  const failed = (code: string, item = record("required"), details: Record<string, unknown> = {}) => ({ version: 1, status: "failed", effects: noConsumptionWrites(),
    error: { code, message: "Controlled SDK failure", details: { ...details, preparation: { status: "failed", scope,
      required: [], nodes: [{ state: "failed", id: item.id, ref: item.ref, roles: ["root"], error: { code, details: { id: item.id,
        ...(typeof details.page_id === "string" ? { page_id: details.page_id } : {}) } } }] } } } });
  const read = async (path: string, refresh?: boolean, from?: string) => {
    const input = { path, ...(refresh === undefined ? {} : { refresh }), ...(from === undefined ? {} : { from }) }, toolCallId = "read-" + branch.length;
    const admitted = await emit("tool_call", { toolName: "read", toolCallId, input });
    const blocked = admitted.find(value => value && typeof value === "object" && "block" in value);
    if (blocked) throw Object.assign(new Error(String(Reflect.get(blocked, "reason"))), { admission: Reflect.get(blocked, "admission") });
    const content = [{ type: "text" as const, text: await readFile(input.path, "utf8") }];
    const event = { toolName: "read", toolCallId, content }, result = (await emit("tool_result", event)).find(value => value !== undefined);
    return { role: "toolResult", ...event, ...(result as Record<string, unknown> ?? {}) } as AgentMessage;
  };
  const command = (name: string) => { const found = commands.get(name); assert.ok(found); return found; };
  return { f, record, ready, failed, revise, seed, seedLocal, turn, close, emit, ctx, api, tool, command, branch, read,
    fixedRef: (record: SkillRecord) => createSessionShortRefHost(api).selected(ctx, record),
    selected: () => sessionSelection(ctx), active: () => activeSources(ctx), delivered };
}
