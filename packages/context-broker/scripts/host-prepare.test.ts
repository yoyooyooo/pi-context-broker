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
import { deduplicateSourceReads, deferredSourceEntries, sourceDeliveryReceipt, sourceBodyLoaded, sourceMessageText, sessionSourceBindings, withSessionSourceReceipts } from "../src/session-source-snapshot";
import { materializeNotionEntryFile, publishNotionEntry } from "../src/notion-entry";
import { projectCatalogDescriptions } from "../src/skill-catalog-projection";
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
async function fixture(withShortRefs = false, withDirectoryAlias = false, hostKind: "pi" | "omp" = "pi", identityScope = scope, withBodyCard = false) {
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
      id, kind: "skill", name, alias: name, description: withBodyCard && name === "member" ? 'Controlled member <metadata> & "原文".' : "Controlled " + name, enabled: true, default_context: index === 0,
      entrypoint: "SKILL.md", ref: "skill://" + encodeURIComponent(id) + "/SKILL.md",
      locator: { type: "shared_skill", library_id: "controlled", skill_id: name, page_id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
        database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" },
    };
    const body = "\ufeff---\r\nname: " + name + "\r\n---\r\nExact " + name + " <instructions>.\r\n"
      + (withBodyCard && name === "root" ? '\r\n## Members\r\n\r\n- [member](skill://shared_skill%3Acontrolled%3Amember/SKILL.md) — Controlled member <metadata> & "原文".\r\n' : "");
    const snapshotId = "s_" + hash(name), path = join(directory, name, "SKILL.md");
    await mkdir(join(directory, name), { recursive: true });
    await writeFile(path, body);
    let selected: SkillRecord = {
      ...metadata, source: "notion", sourceId: "controlled", sourceScope: identityScope, body, path, snapshotId, versionId: hash(body),
      aliases: [], normalizedAliases: [], normalizedName: name, normalizedDescription: metadata.description, autoloadEnabled: true, defaultDiscovery: false,
      preparationBinding: { record: metadata, scope: identityScope, snapshot_id: snapshotId, version_id: hash(body), body_sha256: hash(body), ref: metadata.ref + "?snapshot=" + snapshotId },
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
  const sources: Array<{ id: string; type: "notion"; prefetch: false }> = [{ id: "controlled", type: "notion", prefetch: false }];
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  let search: NativeSkillSearchDefinition | undefined, tool: NativeSkillPrepareDefinition | undefined, graphTool: NativeSkillGraphDefinition | undefined;
  const api: ExtensionAPI = { ...(hostKind === "omp" ? { pi: {} } : {}), on(name, listener) { events.set(name, [...events.get(name) ?? [], listener]); },
    appendEntry(customType, data) { session.entries.push({ type: "custom", customType, data }); },
    registerTool(value) { if (value.name === "skill_search" || value.name === "notion_list") search = value; if (value.name === "skill_prepare" || value.name === "notion_use") tool = value; if (value.name === "skill_graph" || value.name === "notion_ctl") graphTool = value; } };
  function graph(purpose: PreparationPurpose): PreparedHostGraph {
    const selected = purpose === "use" ? [root!, required!] : [root!];
    const vector = { version: 1 as const, kind: "observed_version_vector" as const, purpose, scope: identityScope, roots: [root!.id!],
      required: purpose === "use" ? [{ from: root!.id!, to: required!.id!, ref: required!.preparationBinding!.ref }] : [],
      bindings: selected.map(record => record.preparationBinding!) };
    return { purpose, sourceId: "controlled", scope: identityScope, roots: [root!.id!], records: selected, bindings: selected.map(record => record.preparationBinding!), lock: { ...vector, sha256: hash(canonical(vector)) },
      budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
      usage: { prepared_nodes: selected.length, instruction_bytes: selected.reduce((n, record) => n + Buffer.byteLength(record.body!), 0), context_bytes: 4000, max_depth: purpose === "use" ? 1 : 0 } };
  }
  const install = async (prepareGraph: (purpose: PreparationPurpose, signal?: AbortSignal) => Promise<PreparedHostGraph[]> = async purpose => [graph(purpose)], discovery: Partial<Pick<HostSkillOptions, "getRecords" | "lookupReference">> = {}) => {
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
      prepareGraph: async (_records, _ctx, signal, purpose) => { calls.push(purpose); return prepareGraph(purpose, signal); },
      persistGraphs: (_graphs, _ctx, mode) => { persisted.push(mode); },
      ...(withShortRefs ? { sessionGraph: () => ({ kind: "controlled-selected-graph", scope: identityScope }) } : {}),
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
  return { ctx, records, root: root!, required: required!, member: member!, graph, calls, persisted, install, emit, session, resourceText, resourceReads, api, sources };
}

test("Pi projects the ready default catalog after explicit preparation, not the earlier pending observation", async () => {
  const f = await fixture(true), metadata = Promise.withResolvers<Awaited<ReturnType<HostSkillOptions["getRecords"]>>>();
  await f.install(undefined, { getRecords: () => metadata.promise });
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
  const head = { role: "system", content: beforePrompt, sections: { local: "Keep the native local rules" },
    toolsAdded: [{ name: "read", parameters: { type: "object" } }] };
  const messages = [head, user], original = JSON.stringify(messages);
  const projected = await f.emit("context_with_system", { messages }, f.ctx);
  const actual = JSON.stringify(projected.length ? projected : { messages });
  expect(actual).toContain("<name>root</name>");
  expect(actual).toContain("<name>member</name>");
  expect(actual).not.toContain("<name>required</name>");
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
  expect(JSON.stringify(provider)).toContain("<name>root</name>");
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
  expect(actual).toContain("<name>root</name>");
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
  expect(initial.catalog).toContain('<description>Controlled member &lt;metadata&gt; &amp; &quot;原文&quot;.</description>');
  expect(projected.catalog).not.toContain('<description>Controlled member');
  expect(projected.catalog).toContain('<description>Controlled root</description>');
  expect(projected.catalog).toContain('<description>Controlled required</description>');
  expect(projected.catalog.match(/<skill>/g)).toHaveLength(3);
  expect([...projected.catalog.matchAll(/<location>(.*?)<\/location>/g)].map(match => match[1]))
    .toEqual([...initial.catalog.matchAll(/<location>(.*?)<\/location>/g)].map(match => match[1]));
  expect(projected.messages.slice(2)).toEqual([f.injected, f.requiredInjection]);
  expect(JSON.stringify(input)).toBe(before);
  expect(sourceBodyLoaded(input, f.root)).toBe(true);
  expect(sourceBodyLoaded(input, f.required)).toBe(true);
  expect(f.calls).toEqual(["use"]);
  expect(f.resourceReads).toEqual([]);
});

test("Pi dollar notion-page injection uses the binding's canonical selector without confusing its logical record ID", async () => {
  const f = await dollarCatalogFixture(), original = f.root.preparationBinding!;
  const page = "00000000-0000-4000-8000-000000000001", ref = "skill://" + page + "/SKILL.md";
  const record: ContentRecord = { ...original.record, id: "notion_page:" + page, ref,
    locator: { type: "notion_page", page_id: page, database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" } };
  const selected: SkillRecord = { ...f.root, ...record, preparationBinding: { ...original, record, ref: ref + "?snapshot=" + original.snapshot_id } };
  const injected = buildInjectedContextMessage(selected, selected.name), before = JSON.stringify(injected);
  expect((await catalogProjection(f, [f.head, injected])).catalog).not.toContain('<description>Controlled member');
  expect(JSON.stringify(injected)).toBe(before);
  expect(sourceBodyLoaded([injected], selected)).toBe(true);
  const wrongMain = { ...selected, preparationBinding: { ...selected.preparationBinding!, ref: selected.preparationBinding!.ref.replace(page, "00000000-0000-4000-8000-000000000099") } };
  expect((await catalogProjection(f, [f.head, buildInjectedContextMessage(wrongMain, wrongMain.name)])).catalog).toContain('<description>Controlled member');
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
  expect((await catalogProjection(f, input)).catalog).not.toContain('<description>Controlled member');
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
  ]) expect((await catalogProjection(f, messages)).catalog).toContain('<description>Controlled member');
  expect((await catalogProjection(f, input)).catalog).not.toContain('<description>Controlled member');
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
    expect(catalog).not.toContain('<description>Controlled member');
    expect(catalog).toContain('<description>Controlled root</description>');
    expect(catalog).toContain('<description>Controlled required</description>');
    expect(catalog.match(/<skill>/g)).toHaveLength(3);
  }
  for (const messages of [[followup], [{ ...restored, content: "Compacted summary." }],
    [{ ...restored, content: sourceMessageText(restored.content).slice(0, -100) }]])
    expect(await project(messages)).toContain('<description>Controlled member');
  expect(JSON.stringify({ entries, restored })).toBe(original);
  f.ctx.sessionManager.buildSessionProjection = () => ({ entries: [], messages: [restored] });
  expect(await project([restored])).toContain('<description>Controlled member');
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
    record => { record.preparationBinding!.record.id = "shared_skill:controlled:other-root"; },
    record => { record.preparationDirectory!.candidates = [{ ...record.preparationDirectory!.candidates[0]!, id: "shared_skill:controlled:other-member" }]; },
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
    expect((await catalogProjection(f, [f.head, message])).catalog).toContain('<description>Controlled member');
  }
  expect((await catalogProjection(f, [f.head, f.injected])).catalog).not.toContain('<description>Controlled member');
  expect(f.calls).toEqual(["use"]);
  expect(f.resourceReads).toEqual([]);
});

test("Pi dollar catalog reuse preserves same-name sources, owners and newly observed descriptions", async () => {
  const f = await fixture(true, false, "pi", scope, true), head: AgentMessage = { role: "system", content: "Native rules" };
  f.sources.push({ id: "other-source", type: "notion", prefetch: false });
  const id = "shared_skill:controlled:other-member";
  const otherOwner = { ...f.member, id, token: "other-owner-member", ref: "skill://" + encodeURIComponent(id) + "/SKILL.md",
    locator: { ...f.member.locator!, skill_id: "other-member", page_id: "00000000-0000-4000-8000-000000000004" } };
  const otherSource = { ...f.member, sourceId: "other-source", token: "other-source-member" };
  const { search, host } = await f.install(undefined, { getRecords: async () => ({ records: [...f.records, otherOwner, otherSource].map(record => ({
    ...record, body: undefined, preparationBinding: undefined, defaultDiscovery: true,
  })), failures: [] }) });
  await search.execute("dollar-aliases", {}, undefined, undefined, f.ctx);
  await host.prepareMany([f.root], f.ctx);
  const injected = buildInjectedContextMessage(f.root, "root");
  const projected = await catalogProjection(f, [head, injected]);
  const members = [...projected.catalog.matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map(match => match[1]!).filter(card => card.includes("<name>member</name>"));
  expect(members).toHaveLength(3);
  const sameSource = members.filter(card => card.includes("<source>controlled</source>"));
  expect(sameSource).toHaveLength(2);
  expect(sameSource.filter(card => card.includes("<description>"))).toHaveLength(1);
  expect(members.find(card => card.includes("<source>other-source</source>"))).toContain("<description>");
  const before = sourceMessageText(injected.content);
  f.member.description = "New authoritative member description.";
  await host.refresh(f.ctx);
  const refreshed = await catalogProjection(f, [head, injected]);
  expect(refreshed.catalog).toContain("<description>New authoritative member description.</description>");
  expect(refreshed.catalog.match(/<description>/g)).toHaveLength(5);
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
  const cards = [...projected.catalog.matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map(match => match[1]!);
  const original = cards.find(card => card.includes("<name>member</name>") && card.includes("<source>controlled</source>"));
  const other = cards.find(card => card.includes("<name>member</name>") && card.includes("<source>other-source</source>"));
  expect(original).toBeDefined(); expect(other).toBeDefined();
  expect(/<location>([^<]+)<\/location>/.exec(original!)![1]).toBe(/<location>([^<]+)<\/location>/.exec(other!)![1]);
  expect(original).not.toContain("<description>Controlled member</description>");
  expect(other).toContain("<description>Controlled member</description>");
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
  expect(projected.catalog).not.toContain("<description>Controlled member</description>");
  expect(projected.catalog).toContain("<description>Controlled root</description>");
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
      record: { ...record, locator: { ...locator, library_id: "another-library" } } } } } },
  ]) {
    expect((await catalogProjection(f, [head, candidate])).catalog).toContain("<description>Controlled member</description>");
  }
  expect((await catalogProjection(f, [head])).catalog).toContain("<description>Controlled member</description>");
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
  expect(projected.catalog).toContain("<name>member</name>");
  expect(projected.catalog).not.toContain("<description>Controlled member</description>");
  expect(projected.catalog).toContain("<description>Controlled root</description>");
  expect(projected.catalog).toContain("<description>Controlled required</description>");
  expect(projected.catalog.match(/<skill>/g)).toHaveLength(3);
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
  expect(restored.catalog).toContain("<description>Controlled member</description>");
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
    expect(projected.catalog).toContain("<description>Controlled member</description>");
    expect(projected.messages).toContain(candidate);
    expect(JSON.stringify(candidate)).toBe(before);
  }
  const foreign = await fixture(true, false, "pi", "b".repeat(64));
  const other = await foreign.install();
  const foreignUse = await other.tool.execute("foreign", { ref: foreign.root.ref }, undefined, undefined, foreign.ctx);
  f.session.entries.push(...foreign.session.entries);
  expect((await catalogProjection(f, [head, { role: "toolResult", toolName: "notion_use", toolCallId: "foreign",
    content: foreignUse.content, details: foreignUse.details, isError: false }])).catalog).toContain("<description>Controlled member</description>");
  f.root.preparationDirectory!.candidates[0]!.description = "A different metadata observation";
  const changed = await tool.execute("metadata-changed", { ref: f.root.ref }, undefined, undefined, f.ctx);
  expect((await catalogProjection(f, [head, { role: "toolResult", toolName: "notion_use", toolCallId: "metadata-changed",
    content: changed.content, details: changed.details, isError: false }])).catalog).toContain("<description>Controlled member</description>");
  f.root.preparationDirectory!.candidates[0]!.description = f.member.description;
  f.root.preparationDirectory!.candidates[0]!.ref = f.member.ref + "?snapshot=s_" + hash("historical-member");
  const fixed = await tool.execute("fixed-candidate", { ref: f.root.ref }, undefined, undefined, f.ctx);
  expect((await catalogProjection(f, [head, { role: "toolResult", toolName: "notion_use", toolCallId: "fixed-candidate",
    content: fixed.content, details: fixed.details, isError: false }])).catalog).toContain("<description>Controlled member</description>");
  f.session.entries = [];
  expect((await catalogProjection(f, [head, use])).catalog).toContain("<description>Controlled member</description>");
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
