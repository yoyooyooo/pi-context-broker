import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeSources, activeSelection, missingActiveSources, assertRestoredSource, confirmActiveSources, SESSION_ACTIVE_ENTRY } from "../src/session-active";
import { persistSessionSelection } from "../src/session-graph";
import { sourceDeliveryReceipt, projectSelectedSourceMessages, deferredSourceEntries, nativeReadReceipt, sourceBodyLoaded, sourceMessageText, withSessionSourceReceipts } from "../src/session-source-snapshot";
import { installHostSkills, type HostSkillOptions } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { discoverSourceCatalog, loadSourceSkill } from "../src/sources";
import type { PreparedHostGraph, PreparationPurpose } from "../src/prepare-protocol";
import type { AgentMessage, ContentRecord, ExtensionAPI, ExtensionContext, ProjectedSessionEntry, SessionBoundaryDraft, SessionBoundaryResult, SessionEntry, SkillRecord, TurnEndEvent } from "../src/types";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
const scope = "e".repeat(64);
function graph(revision = "A", purpose: PreparationPurpose = "use"): PreparedHostGraph {
  const records = (purpose === "use" ? ["root", "required"] : ["root"]).map((name): SkillRecord => {
    const id = "shared_skill:controlled:" + name;
    const metadata: ContentRecord = { id, kind: "skill", name, alias: name, description: name, enabled: true, default_context: false,
      entrypoint: "SKILL.md", ref: "skill://" + encodeURIComponent(id) + "/SKILL.md",
      locator: { type: "shared_skill", library_id: "controlled", skill_id: name, page_id: "00000000-0000-4000-8000-000000000001", database_id: "00000000-0000-4000-8000-000000000002", data_source_id: "00000000-0000-4000-8000-000000000003" } };
    const body = `Complete ${name} instructions ${revision}.\n`, snapshotId = "s_" + hash(name + revision);
    return { ...metadata, source: "notion", sourceId: "controlled", sourceScope: scope, body, snapshotId, versionId: hash(body),
      path: "/immutable/" + name + "/SKILL.md", aliases: [], normalizedName: name, normalizedAliases: [], normalizedDescription: name, autoloadEnabled: false,
      preparationBinding: { record: metadata, scope, snapshot_id: snapshotId, version_id: hash(body), body_sha256: hash(body), ref: metadata.ref + "?snapshot=" + snapshotId } };
  });
  const vector = { version: 1 as const, kind: "observed_version_vector" as const, purpose, scope, roots: [records[0]!.id!],
    required: purpose === "use" ? [{ from: records[0]!.id!, to: records[1]!.id!, ref: records[1]!.preparationBinding!.ref }] : [], bindings: records.map(record => record.preparationBinding!) };
  return { purpose, scope, sourceId: "controlled", roots: vector.roots, records, bindings: vector.bindings, lock: { ...vector, sha256: hash(canonical(vector)) },
    budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144 },
    usage: { prepared_nodes: records.length, instruction_bytes: 100, context_bytes: 100, max_depth: 1 } };
}
function fixture() {
  const branch: SessionEntry[] = [];
  const ctx: ExtensionContext = { sessionManager: { getBranch: () => branch } };
  const api: ExtensionAPI = { on() {}, appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); } };
  return { branch, api, ctx };
}
const delivered = (records: SkillRecord[]): AgentMessage[] => records.map(record => ({ role: "custom", customType: "context-broker", content: record.body,
  details: { records: [sourceDeliveryReceipt(record, record.body!)] } }));

test("selected use and ready partial delivery remain inactive until a complete confirmed closure", () => {
  const f = fixture(), prepared = graph();
  persistSessionSelection(f.api, f.ctx, [prepared], "extend");
  expect(activeSources(f.ctx).sources.size).toBe(0);
  confirmActiveSources(f.api, f.ctx, prepared.records, delivered([prepared.records[0]!]));
  expect(activeSources(f.ctx).sources.size).toBe(0);
  confirmActiveSources(f.api, f.ctx, prepared.records, delivered(prepared.records));
  expect(activeSources(f.ctx).sources.size).toBe(2);
  confirmActiveSources(f.api, f.ctx, prepared.records, delivered(prepared.records));
  expect(f.branch.filter(entry => entry.customType === SESSION_ACTIVE_ENTRY)).toHaveLength(1);
  expect([...activeSources(f.ctx).sources.values()].every(source => source.record.body === undefined)).toBe(true);
});
test("inspection is not activated even when its full bytes reach a provider", () => {
  const f = fixture(), prepared = graph("A", "inspect");
  persistSessionSelection(f.api, f.ctx, [prepared], "extend");
  confirmActiveSources(f.api, f.ctx, prepared.records, delivered(prepared.records));
  expect(activeSources(f.ctx).sources.size).toBe(0);
});
test("a real filesystem source can confirm complete delivery and resume without a Notion graph", async () => {
  const directory = await mkdtemp(join(tmpdir(), "broker-active-local-"));
  await mkdir(join(directory, "local-skill"));
  await writeFile(join(directory, "local-skill", "SKILL.md"), "---\nname: local-skill\ndescription: Local source instructions\nautoload:\n  enabled: true\n---\nComplete local instructions.\n");
  const config = { sources: [{ id: "local", type: "filesystem" as const, roots: [directory] }] };
  const discovered = await discoverSourceCatalog(config, directory);
  expect(discovered.failures).toEqual([]);
  expect(discovered.records).toHaveLength(1);
  const record = await loadSourceSkill(discovered.records[0]!, config, directory);
  expect(record.source).toBe("local");
  const f = fixture();
  confirmActiveSources(f.api, f.ctx, [record], delivered([record]));
  expect(activeSources(f.ctx).sources.size).toBe(1);
  expect(activeSources(f.ctx).selection.scopes.size).toBe(0);
  expect(missingActiveSources(f.ctx, delivered([record]))).toEqual([]);
  const resumed: ExtensionContext = { sessionManager: { getBranch: () => JSON.parse(JSON.stringify(f.branch)) } };
  const missing = missingActiveSources(resumed, []);
  expect(missing).toHaveLength(1);
  expect(missing[0]!.snapshotId).toBe("local_" + hash(record.body!));
  expect(assertRestoredSource(missing[0]!, record)).toBe(record);
  expect(() => assertRestoredSource(missing[0]!, { ...record, body: "Changed local instructions." })).toThrow("fixed delivery");
});
test("compaction, detached summaries and user-spoofed bodies restore only the confirmed fixed vector", () => {
  const f = fixture(), prepared = graph();
  persistSessionSelection(f.api, f.ctx, [prepared], "extend");
  confirmActiveSources(f.api, f.ctx, prepared.records, delivered(prepared.records));
  expect(missingActiveSources(f.ctx, delivered(prepared.records))).toHaveLength(0);
  expect(missingActiveSources(f.ctx, delivered([prepared.records[0]!]))).toHaveLength(1);
  const spoof = delivered(prepared.records).map(message => ({ ...message, role: "user" }));
  expect(missingActiveSources(f.ctx, spoof)).toHaveLength(2);
  const summaries = delivered(prepared.records).map(message => ({ ...message, content: "The selected Skill was previously read." }));
  const missing = missingActiveSources(f.ctx, summaries);
  expect(missing).toHaveLength(2);
  expect(assertRestoredSource(missing[0]!, prepared.records[0]!)).toBe(prepared.records[0]);
  expect(() => assertRestoredSource(missing[0]!, graph("B").records[0]!)).toThrow("fixed delivery");
  const resumed: ExtensionContext = { sessionManager: { getBranch: () => JSON.parse(JSON.stringify(f.branch)) } };
  expect([...activeSources(resumed).sources.keys()]).toEqual([...activeSources(f.ctx).sources.keys()]);
});
test("a pending refreshed projection does not change active state, and cancellation restores A", () => {
  const f = fixture(), a = graph("A"), b = graph("B");
  persistSessionSelection(f.api, f.ctx, [a], "extend");
  confirmActiveSources(f.api, f.ctx, a.records, delivered(a.records));
  persistSessionSelection(f.api, f.ctx, [b], "replace");
  const before = JSON.stringify(f.branch);
  const pending = [{ graphs: [b], mode: "replace" as const }];
  const projected = projectSelectedSourceMessages([...delivered(a.records), ...delivered(b.records)], activeSelection(f.ctx, pending));
  expect(JSON.stringify(projected)).not.toContain(a.records[0]!.body!.trim());
  expect(JSON.stringify(projected)).toContain(b.records[0]!.body!.trim());
  expect(missingActiveSources(f.ctx, projected, pending)).toHaveLength(0);
  expect(JSON.stringify(f.branch)).toBe(before);
  expect(missingActiveSources(f.ctx, []).map(source => source.snapshotId)).toEqual(a.records.map(record => record.snapshotId!));
  confirmActiveSources(f.api, f.ctx, b.records, projected);
  expect(missingActiveSources(f.ctx, []).map(source => source.snapshotId)).toEqual(b.records.map(record => record.snapshotId!));
});
test("unknown receipt versions and tampered bodies fail closed instead of falling back to aliases", () => {
  const f = fixture(), prepared = graph();
  persistSessionSelection(f.api, f.ctx, [prepared], "extend");
  confirmActiveSources(f.api, f.ctx, prepared.records, delivered(prepared.records));
  const entry = f.branch.find(entry => entry.customType === SESSION_ACTIVE_ENTRY)!;
  const original = entry.data;
  entry.data = { ...original as Record<string, unknown>, compiler_version: 2 };
  expect(() => activeSources(f.ctx)).toThrow("Invalid active");
  entry.data = original;
  const other: ExtensionContext = { sessionManager: { getBranch: () => [] } };
  expect(activeSources(other).sources.size).toBe(0);
});

async function deferredFixture(prepared?: PreparedHostGraph) {
  const listeners = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const queued: AgentMessage[] = [], controller = new AbortController(), entries: ProjectedSessionEntry[] = [];
  const restored: string[][] = [];
  const state = { sessionId: "prompt-run" };
  const api: ExtensionAPI = {
    on(name, handler) { listeners.set(name, [...listeners.get(name) ?? [], handler]); },
    sendMessage(message) { queued.push({ ...message, role: "custom" }); },
    appendEntry(customType, data) { entries.push({ sourceEntry: { type: "custom", customType, data, id: "custom-" + entries.length }, messages: [] }); },
  };
  const messages = () => entries.flatMap(entry => entry.messages);
  const ctx: ExtensionContext = { signal: controller.signal, abort: () => controller.abort(), sessionManager: {
    getSessionId: () => state.sessionId, buildSessionProjection: () => ({ entries, messages: messages() }),
    getBranch: () => entries.map(entry => entry.sourceEntry),
    getEntries() { throw new Error("Deferred delivery must not read all session history"); },
  } };
  const sourceMessage = (records: readonly SkillRecord[]) => {
    const content = records.map(record => record.body!).join("\n\n");
    return { customType: "context-broker", content, display: false,
      details: { records: records.map(record => sourceDeliveryReceipt(record, content)) } };
  };
  await installHostSkills(api, { config: {}, getRecords: async () => ({ records: prepared?.records ?? [], failures: [] }), loadRecord: async record => record,
    needsPreflightPrompt: text => text.includes("$task"), taskPrompt: async text => prepared ? text : text + "\n\nTASK_BODY_ONCE",
    ...(prepared ? {
      prepareGraph: async () => [prepared],
      buildPreparedPrompt: async (_text, _ctx, _signal, records) => sourceMessage(records),
      persistGraphs: (graphs, context, mode) => persistSessionSelection(api, context, graphs, mode),
      confirmDelivery: (records, deliveredMessages, context) => confirmActiveSources(api, context, records, deliveredMessages),
      restoreActive: async (deliveredMessages, context, _signal, pending) => {
        const missing = missingActiveSources(context, deliveredMessages, pending);
        if (!missing.length) return undefined;
        restored.push(missing.map(source => source.record.id!));
        return sourceMessage(missing.map(source => {
          const record = prepared.records.find(record => record.id === source.record.id);
          if (!record) throw new Error("Expected the fixed fixture owner");
          return assertRestoredSource(source, record);
        }));
      },
    } satisfies Pick<HostSkillOptions, "prepareGraph" | "buildPreparedPrompt" | "persistGraphs" | "confirmDelivery" | "restoreActive"> : {}),
  }, createPiHostAdapter(api));
  const emit = async (name: string, event: unknown = {}) => {
    const results = [];
    for (const handler of listeners.get(name) ?? []) results.push(await handler(event as never, ctx));
    return results;
  };
  const input = prepared ? "/skill:root keep the task" : "$task keep the task";
  const submitted = prepared ? "\n" + input : input;
  const user: AgentMessage = { role: "user", content: [{ type: "text", text: submitted }, { type: "image", data: "preserved", mimeType: "image/png" }] };
  const accepted = await emit("input", { source: "rpc", text: input });
  if (prepared) expect(accepted).toContainEqual({ action: "transform", text: submitted, images: undefined });
  await emit("before_agent_start", { prompt: submitted, systemPrompt: "base" });
  await emit("agent_start");
  // Pi persists the actual user after agent_start and before the first context.
  entries.push({ sourceEntry: { type: "message", id: "user", message: user }, messages: [user] });
  let turn = 0;
  const request = async (status: number | null = 200, nativeRead?: SkillRecord) => {
    const contexts = await emit("context", { messages: messages() });
    await emit("before_provider_request", { type: "before_provider_request", payload: {} });
    if (status !== null) await emit("after_provider_response", { type: "after_provider_response", status, headers: {} });
    const assistant: AgentMessage = { role: "assistant", content: "OK" };
    const toolCallId = "ordinary-" + turn;
    const content = nativeRead ? nativeRead.body + "\nReference directory stays." : "resource";
    const tool: AgentMessage = { role: "toolResult", toolName: "read", toolCallId, content,
      ...(nativeRead ? { details: { contextBrokerRead: nativeReadReceipt(nativeRead, toolCallId, content) } } : {}) };
    entries.push({ sourceEntry: { type: "message", id: "assistant-" + turn, message: assistant }, messages: [assistant] },
      { sourceEntry: { type: "message", id: "tool-" + turn, message: tool }, messages: [tool] });
    turn++;
    return contexts;
  };
  const boundary = async (outcome: TurnEndEvent["outcome"] = "completed", previous: SessionBoundaryDraft[] = []) => {
    const results = await emit("turn_end", { type: "turn_end", turnIndex: turn - 1, outcome, entries: previous, continue: false,
      messageEntryId: "assistant-" + (turn - 1), toolResultEntryIds: ["tool-" + (turn - 1)],
      context: { contextEntries: entries, contextMessages: messages() } });
    return results.find((value): value is SessionBoundaryResult => !!value && typeof value === "object" && "entries" in value && Array.isArray(value.entries));
  };
  const apply = (drafts: readonly SessionBoundaryDraft[]) => {
    for (const draft of drafts) {
      if (draft.type === "context_edit") {
        const target = entries.find(entry => entry.sourceEntry.id === draft.targetId)!;
        target.messages = draft.replacement === null ? [] : target.messages.map(message => ({ ...message, content: draft.replacement!.content }));
      } else if (draft.type === "custom") entries.push({ sourceEntry: { ...draft, id: "custom-" + entries.length }, messages: [] });
    }
  };
  const close = async () => { await emit("agent_end"); await emit("session_shutdown"); };
  return { entries, user, queued, restored, state, controller, emit, request, boundary, apply, close };
}

test("deferred Prompt persistence preserves images, current edits and tool ordering without a queued custom message", async () => {
  const f = await deferredFixture();
  const projectedContent = [...(Array.isArray(f.user.content) ? f.user.content : []), { type: "text" as const, text: "Earlier context edit." }];
  const projected: AgentMessage = { ...f.user, content: projectedContent };
  f.entries[0]!.messages = [projected];
  expect(JSON.stringify(await f.request()).split("TASK_BODY_ONCE").length - 1).toBe(1);
  expect(f.queued).toEqual([]);
  const prior: SessionBoundaryDraft = { type: "custom", customType: "other-extension", data: { keep: true } };
  const boundary = await f.boundary("completed", [prior]);
  expect(boundary?.continue).toBeUndefined();
  expect(boundary?.entries?.[0]).toBe(prior);
  f.apply(boundary!.entries!);
  expect(f.entries[0]!.sourceEntry.message).toBe(f.user);
  expect(sourceMessageText(f.user.content)).not.toContain("TASK_BODY_ONCE");
  expect(f.entries[0]!.messages[0]!.content).toEqual([...projectedContent, { type: "text", text: "TASK_BODY_ONCE" }]);
  expect(f.entries.flatMap(entry => entry.messages).filter(message => message.role !== "user").map(message => [message.role, message.toolCallId])).toEqual([
    ["assistant", undefined], ["toolResult", "ordinary-0"],
  ]);
  const second = await f.request();
  expect(JSON.stringify(second).split("TASK_BODY_ONCE").length - 1).toBe(1);
  expect(JSON.stringify(second)).not.toContain("nativePromptSha256");
  expect(await f.boundary()).toBeUndefined();
  expect(f.queued).toEqual([]);
  await f.close();
});

test("deferred slash selection preserves root and Requires receipts across native read and later provider turns", async () => {
  const prepared = graph(), f = await deferredFixture(prepared);
  try {
    const originalUser = JSON.stringify(f.user);
    const projectedContent = [...(Array.isArray(f.user.content) ? f.user.content : []), { type: "text" as const, text: "Earlier context edit." }];
    f.entries[0]!.messages = [{ ...f.user, content: projectedContent }];
    await f.request(200, prepared.records[0]);
    const rawTool = JSON.stringify(f.entries.find(entry => entry.sourceEntry.id === "tool-0")!.sourceEntry);
    const first = await f.boundary();
    expect(first?.entries).toHaveLength(2);
    f.apply(first!.entries!);
    const persisted = JSON.stringify(f.entries[0]!.messages[0]);
    const proof = JSON.stringify(first!.entries![1]);
    for (let index = 0; index < 2; index++) {
      const result = (await f.request()).find((value): value is { messages: AgentMessage[] } =>
        !!value && typeof value === "object" && "messages" in value && Array.isArray(value.messages));
      if (!result) throw new Error("Expected the provider context");
      expect(f.restored).toEqual([]);
      for (const record of prepared.records) {
        const copies = result.messages.reduce((count, message) => count + sourceMessageText(message.content).split(record.body!).length - 1, 0);
        expect(copies).toBe(1);
      }
      expect(sourceMessageText(result.messages.find(message => message.toolCallId === "ordinary-0")?.content)).toBe("Already loaded.\nReference directory stays.");
      expect(await f.boundary()).toBeUndefined();
      expect(JSON.stringify(f.entries[0]!.messages[0])).toBe(persisted);
      expect(JSON.stringify(first!.entries![1])).toBe(proof);
      expect(JSON.stringify(f.entries.find(entry => entry.sourceEntry.id === "tool-0")!.sourceEntry)).toBe(rawTool);
    }
    expect(JSON.stringify(f.user)).toBe(originalUser);
    expect(f.entries[0]!.messages[0]!.content).toEqual([...projectedContent,
      { type: "text", text: prepared.records.map(record => record.body!).join("\n\n") },
      { type: "text", text: '<notion-effects>{"version":1,"remote_writes":"unknown","author_content":"unknown","retention":[]}</notion-effects>' }]);
    expect(f.entries.filter(entry => entry.sourceEntry.type === "message").map(entry => entry.sourceEntry.id)).toEqual([
      "user", "assistant-0", "tool-0", "assistant-1", "tool-1", "assistant-2", "tool-2",
    ]);
    expect(f.queued).toEqual([]);
  } finally { await f.close(); }
});

test("discarded boundary drafts do not falsely mark a deferred Prompt persisted", async () => {
  const f = await deferredFixture();
  await f.request(); expect((await f.boundary())?.entries).toHaveLength(2);
  // Another extension discarded the drafts; native projection is unchanged.
  expect(JSON.stringify(await f.request()).split("TASK_BODY_ONCE").length - 1).toBe(1);
  const retried = await f.boundary(); expect(retried?.entries).toHaveLength(2);
  f.apply(retried!.entries!);
  expect(JSON.stringify(await f.request()).split("TASK_BODY_ONCE").length - 1).toBe(1);
  expect(await f.boundary()).toBeUndefined();
  await f.close();
});

test("failed, aborted, late and rewound deferred deliveries append no projection or proof", async () => {
  for (const mode of ["error", "aborted", "failed-response", "no-response", "cancel", "switch", "rewind"] as const) {
    const f = await deferredFixture();
    await f.request(mode === "failed-response" ? 503 : mode === "no-response" ? null : 200);
    if (mode === "cancel") f.controller.abort();
    if (mode === "switch") { await f.emit("session_before_switch", { type: "session_before_switch" }); f.state.sessionId = "other"; }
    if (mode === "rewind") f.entries.splice(0, 1);
    const before = JSON.stringify(f.entries);
    expect(await f.boundary(mode === "error" || mode === "aborted" ? mode : "completed")).toBeUndefined();
    expect(JSON.stringify(f.entries)).toBe(before);
    expect(f.queued).toEqual([]);
    await f.close();
  }
});

test("projected source receipts retain exact spans across additions and disappear with compacted or foreign user content", () => {
  const [root, required] = graph().records;
  const user: AgentMessage = { role: "user", content: "Original user" };
  const entries: ProjectedSessionEntry[] = [{ sourceEntry: { type: "message", id: "user", message: user }, messages: [user] }];
  const first = deferredSourceEntries(entries, "user", delivered([root!]))!;
  const edit = first.entries[0]!, proof = first.entries[1]!;
  if (edit.type !== "context_edit" || !edit.replacement || proof.type !== "custom") throw new Error("Expected native projection drafts");
  entries[0]!.messages = [{ ...user, content: edit.replacement.content }];
  entries.push({ sourceEntry: { ...proof, id: "proof" }, messages: [] });
  const second = deferredSourceEntries(entries, "user", delivered([required!]))!;
  const secondEdit = second.entries[0]!, secondProof = second.entries[1]!;
  if (secondEdit.type !== "context_edit" || !secondEdit.replacement || secondProof.type !== "custom") throw new Error("Expected native projection drafts");
  entries[0]!.messages = [{ ...user, content: secondEdit.replacement.content }];
  entries.push({ sourceEntry: { ...secondProof, id: "proof-2" }, messages: [] });
  const active = withSessionSourceReceipts(entries[0]!.messages, entries);
  expect(sourceBodyLoaded(active, root!)).toBe(true);
  expect(sourceBodyLoaded(active, required!)).toBe(true);
  expect(withSessionSourceReceipts([], entries)).toEqual([]);
  expect(withSessionSourceReceipts([{ role: "user", content: "Compacted summary." }], entries)).toEqual([{ role: "user", content: "Compacted summary." }]);
  expect(sourceBodyLoaded(withSessionSourceReceipts(entries[0]!.messages, []), root!)).toBe(false);
  expect(deferredSourceEntries(entries.slice(1), "user", delivered([root!]))).toBeUndefined();
});
