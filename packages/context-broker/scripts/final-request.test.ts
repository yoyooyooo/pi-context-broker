import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type { AgentMessage } from "../src/types";
import { deferredSourceEntries, sourceBodyLoaded, sourceDeliveryReceipt, withSessionSourceReceipts } from "../src/session-source-snapshot";
import {
  assessFinalRequestPayload,
  createFinalRequestLedger,
  FINAL_REQUEST_LIMIT,
  finalRequestSources,
  formatFinalRequestDiagnostic,
  type FinalRequestInput,
} from "../src/final-request";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const effectsText = "<notion-effects>{\"remote_writes\":\"none\"}</notion-effects>";
const sourceBody = "SOURCE_BODY_ONCE";
const snapshot = "s_" + "a".repeat(64);

function sourceTool(content = sourceBody, id = "use-1"): AgentMessage {
  return {
    role: "toolResult", toolName: "notion_use", toolCallId: id, content,
    details: { contextBrokerPreparation: { toolCallId: id } },
  };
}

function resourceTool(content: string, fields: Record<string, unknown> = {}): AgentMessage {
  const body = content.split("\n\n<notion-effects>")[0] ?? content;
  return {
    role: "toolResult", toolName: "read", toolCallId: "res-1", content,
    details: {
      effects: { version: 1, remote_writes: "none", author_content: "unchanged", retention: [] },
      contextBrokerResource: {
        version: 1, toolCallId: "res-1", id: "page-SECRET", scope: "scope-SECRET", snapshot_id: snapshot,
        file_id: "file-SECRET", path: "references/SECRET.md", ref: "skill://SECRET",
        bytes: Buffer.byteLength(body), sha256: sha(body), delivered_complete_text: true, loaded: false,
        ...fields,
      },
    },
  };
}

function payload(messages: unknown[]) {
  return { model: "fixture", stream: true, messages };
}

function input(messages: readonly AgentMessage[], body: unknown, extra: Partial<FinalRequestInput> = {}): FinalRequestInput {
  return {
    messages, payload: body, api: "openai-completions", baseUrl: extra.baseUrl,
    sessionId: extra.sessionId ?? "session-a", generation: extra.generation ?? 1,
    signal: extra.signal ?? new AbortController().signal, ...extra,
  };
}

test("duplicate, lost, and modified source results fail closed before a digest can confirm", () => {
  const messages = [sourceTool()];
  const ok = payload([{ role: "tool", tool_call_id: "use-1", content: sourceBody }]);
  expect(assessFinalRequestPayload(messages, ok)).toBeUndefined();
  expect(assessFinalRequestPayload(messages, payload([
    { role: "tool", tool_call_id: "use-1", content: sourceBody },
    { role: "tool", tool_call_id: "use-1", content: sourceBody },
  ]))).toBe("DUPLICATE_SOURCE_RESULT");
  expect(assessFinalRequestPayload(messages, payload([]))).toBe("LOST_SOURCE_RESULT");
  expect(assessFinalRequestPayload(messages, payload([{ role: "tool", tool_call_id: "use-1", content: "CHANGED" }]))).toBe("MODIFIED_SOURCE_RESULT");
});

test("scalar resource results and their effects are source deliveries", () => {
  const body = "SECRET_RESOURCE_BODY";
  const content = body + "\n\n" + effectsText;
  const message = resourceTool(content);
  const ok = payload([{ role: "tool", tool_call_id: "res-1", content }]);
  expect(assessFinalRequestPayload([message], ok)).toBeUndefined();
  expect(assessFinalRequestPayload([message], payload([]))).toBe("LOST_SOURCE_RESULT");
  expect(assessFinalRequestPayload([message], payload([{ role: "tool", tool_call_id: "res-1", content: "CHANGED\n\n" + effectsText }]))).toBe("MODIFIED_SOURCE_RESULT");
  expect(assessFinalRequestPayload([message], payload([{ role: "tool", tool_call_id: "res-1", content: body }]))).toBe("DROPPED_EFFECTS");
  const reused = resourceTool("Already available.", { delivered_complete_text: false, bytes: 0, sha256: sha("") });
  expect(finalRequestSources([reused]).sources[0]?.state).toBe("reused");
});

test("batch resource files stay inside the source pin cap", () => {
  const files = Array.from({ length: 10 }, (_, index) => ({ index, sha256: sha("file-" + index), delivered_complete_text: index === 0, state: index === 0 ? "source" : "replaced" }));
  const message: AgentMessage = {
    role: "toolResult", toolName: "read", toolCallId: "batch-1", content: "batch",
    details: { contextBrokerResource: { files, selection: { snapshot_id: snapshot } } },
  };
  const collected = finalRequestSources([message]);
  expect(collected.truncated).toBe(true);
  expect(collected.sources).toHaveLength(8);
  expect(collected.sources[0]?.state).toBe("copied");
  expect(collected.sources[1]?.state).toBe("reused");
  expect(JSON.stringify(collected)).not.toContain("SECRET");
});

test("dropped custom effects are not treated as an absent delivery", () => {
  const messages: AgentMessage[] = [{ role: "custom", customType: "context-broker-consumption-effects", content: effectsText }];
  expect(assessFinalRequestPayload(messages, payload([{ role: "user", content: effectsText }]))).toBeUndefined();
  expect(assessFinalRequestPayload(messages, payload([{ role: "user", content: "no effects" }]))).toBe("DROPPED_EFFECTS");
});

test("broker user and custom deliveries must occur once, and receipt-only entries are not required", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "PROMPT " + sourceBody, details: { records: [{ delivery: { start: 7, end: 22, encoding: "raw" } }] } },
    { role: "custom", customType: "context-broker", content: "", details: { nativePromptSha256: "abc" } },
    { role: "custom", customType: "context-broker-task", content: "TASK_ONCE" },
  ];
  expect(assessFinalRequestPayload(messages, payload([
    { role: "user", content: "PROMPT " + sourceBody },
    { role: "user", content: "TASK_ONCE" },
  ]))).toBeUndefined();
  expect(assessFinalRequestPayload(messages, payload([{ role: "user", content: "PROMPT " + sourceBody }]))).toBe("LOST_SOURCE_RESULT");
});

test("equal ordinary user quotations do not duplicate an owned source object or change its role", () => {
  const messages: AgentMessage[] = [{ role: "custom", customType: "context-broker-task", content: "exact text" },
    { role: "user", content: "exact text" }, { role: "assistant", content: "exact text" }];
  const actual = [{ role: "user", content: "exact text" }, { role: "user", content: "exact text" },
    { role: "assistant", content: "exact text" }];
  expect(assessFinalRequestPayload(messages, payload(actual))).toBeUndefined();
  expect(assessFinalRequestPayload(messages, payload(actual.slice(1)))).toBe("LOST_SOURCE_RESULT");
  expect(assessFinalRequestPayload(messages, payload([{ role: "system", content: "exact text" }, ...actual.slice(1)]))).toBe("LOST_SOURCE_RESULT");
});

test("normal serialized tool declarations retain names, descriptions and exact parameters", () => {
  const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };
  const message = { role: "system", content: "rules", toolsAdded: [tool] };
  const entity = { ...payload([]), tools: [{ type: "function", function: { ...tool, strict: false } }] };
  expect(assessFinalRequestPayload([message], entity)).toBeUndefined();
  expect(assessFinalRequestPayload([{ ...message, toolsAdded: [{ ...tool, constrainedSampling: { type: "json_schema", strict: "prefer" } }] }], entity)).toBeUndefined();
  expect(assessFinalRequestPayload([message], { ...entity, tools: [] })).toBe("MODIFIED_TOOL_SCHEMA");
  const changed = structuredClone(entity); changed.tools[0]!.function.parameters.properties.path.type = "number";
  expect(assessFinalRequestPayload([message], changed)).toBe("MODIFIED_TOOL_SCHEMA");
  const strict = structuredClone(entity); strict.tools[0]!.function.strict = true;
  expect(assessFinalRequestPayload([message], strict)).toBe("UNSUPPORTED_PAYLOAD");
});

test("the diagnostic keeps fixed pins and effect flags without source text or locators", () => {
  const ledger = createFinalRequestLedger();
  const signal = new AbortController().signal;
  const body = "SECRET_RESOURCE_BODY";
  const content = body + "\n\n" + effectsText;
  const message = resourceTool(content);
  const entity = payload([{ role: "tool", tool_call_id: "res-1", content }]);
  ledger.inspect(input([message], entity, { signal, baseUrl: "http://127.0.0.1:9/v1", sessionId: "SECRET_SESSION" }));
  expect(ledger.observeProvider(signal, 200, 1).blocked).toBe(false);
  const row = ledger.recent().at(-1)!;
  expect(row.coverage).toBe("unobserved");
  expect(row.disposition).toBe("logical-only");
  expect(row.wireConfirmed).toBe(false);
  expect(row.sources[0]).toMatchObject({ snapshot, bodySha256: sha(body), state: "copied", remoteWrites: "none", authorContent: "unchanged" });
  const text = formatFinalRequestDiagnostic(ledger);
  expect(text).not.toContain("SECRET");
  expect(text).not.toContain(body);
  expect(text).toContain("copied");
  expect(text).toContain("logical-only");
  ledger.close();
});

test("unsupported api, payload, and transport do not become wire receipts", () => {
  const ledger = createFinalRequestLedger();
  const signals = [new AbortController().signal, new AbortController().signal, new AbortController().signal];
  const messages: AgentMessage[] = [{ role: "user", content: "hello" }];
  expect(ledger.inspect({ ...input(messages, payload([])), api: "anthropic-messages", signal: signals[0] }).block).toBe(false);
  expect(ledger.inspect({ ...input(messages, {}, { signal: signals[1] }), api: "openai-completions" }).block).toBe(false);
  expect(ledger.inspect(input(messages, payload([]), { signal: signals[2], baseUrl: "ws://model.example/socket" })).block).toBe(false);
  for (const signal of signals) expect(ledger.observeProvider(signal, 200, 1).blocked).toBe(false);
  const rows = ledger.recent();
  expect(rows.map(row => row.coverage)).toEqual(["unsupported-api", "unsupported-payload", "unsupported-transport"]);
  expect(rows.every(row => row.wireConfirmed === false && row.dispatched === false && row.logicalProviderStatus === 200)).toBe(true);
  ledger.close();
});

test("missing transport observation stays logical-only", () => {
  const ledger = createFinalRequestLedger();
  const signal = new AbortController().signal;
  const body = payload([{ role: "user", content: "local only" }]);
  ledger.inspect(input([{ role: "user", content: "local only" }], body, { signal, baseUrl: "http://127.0.0.1:9/v1" }));
  expect(ledger.observeProvider(signal, 200, 1).blocked).toBe(false);
  const row = ledger.recent().at(-1)!;
  expect(row.disposition).toBe("logical-only");
  expect(row.wireConfirmed).toBe(false);
  expect(row.dispatched).toBe(false);
  ledger.close();
});

test("rejected checks stay bounded and cannot become wire success", () => {
  const ledger = createFinalRequestLedger();
  const signals: AbortSignal[] = [];
  for (let index = 0; index < FINAL_REQUEST_LIMIT + 3; index += 1) {
    const signal = new AbortController().signal;
    signals.push(signal);
    const decision = ledger.inspect(input([sourceTool("body-" + index, "id-" + index)], payload([]), {
      signal, generation: index, baseUrl: "http://127.0.0.1:9/v1",
    }));
    expect(decision.block).toBe(true);
    expect(ledger.observeProvider(signal, 200, index).blocked).toBe(true);
  }
  const rows = ledger.recent();
  expect(rows).toHaveLength(FINAL_REQUEST_LIMIT);
  expect(rows.every(row => row.wireConfirmed === false)).toBe(true);
  expect(rows.some(row => row.errors.includes("RECORD_LIMIT") || row.errors.includes("LOST_SOURCE_RESULT"))).toBe(true);
  ledger.close();
});

test("host mock context stays logical-only and a lost resource blocks persistence", async () => {
  const { installHostSkills } = await import("../src/host-skills.ts");
  const { createPiHostAdapter } = await import("../src/pi-host-adapter.ts");
  const ledger = createFinalRequestLedger();
  const listeners = new Map<string, Array<(event: never, ctx: never) => unknown>>();
  const controller = new AbortController();
  let persisted = 0;
  const api = {
    on(name: string, handler: (event: never, ctx: never) => unknown) { listeners.set(name, [...listeners.get(name) ?? [], handler]); },
    appendEntry() { persisted += 1; },
  };
  const ctx = {
    signal: controller.signal,
    abort: () => controller.abort(),
    model: undefined as { api?: string; baseUrl?: string } | undefined,
    sessionManager: { getSessionId: () => "host-session", getBranch: () => [], buildSessionProjection: () => ({ entries: [], messages: [] }) },
  };
  await installHostSkills(api, {
    config: {}, getRecords: async () => ({ records: [], failures: [] }), loadRecord: async record => record,
    confirmDelivery: () => { persisted += 1; }, finalRequests: ledger,
  }, createPiHostAdapter(api));
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of listeners.get(name) ?? []) await handler(event as never, ctx as never);
  };
  try {
    await emit("agent_start", {});
    await emit("context", { messages: [{ role: "user", content: "hello" }] });
    ctx.model = { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1" };
    await emit("before_provider_request", { payload: payload([{ role: "user", content: "hello" }]) });
    await emit("after_provider_response", { status: 200, headers: {} });
    expect(ledger.recent().at(-1)?.wireConfirmed).toBe(false);
    expect(ledger.recent().at(-1)?.disposition).toBe("logical-only");
    const before = persisted;
    await emit("context", { messages: [resourceTool("SECRET_RESOURCE_BODY\n\n" + effectsText)] });
    await emit("before_provider_request", { payload: payload([]) });
    expect(controller.signal.aborted).toBe(true);
    await emit("after_provider_response", { status: 200, headers: {} });
    expect(persisted).toBe(before);
    expect(ledger.recent().at(-1)?.errors).toContain("LOST_SOURCE_RESULT");
    expect(ledger.recent().at(-1)?.wireConfirmed).toBe(false);
  } finally {
    await emit("session_shutdown", {});
    ledger.close();
  }
});

test("restored deferred source keeps its user-role obligation privately through later mutable hooks", async () => {
  const { installHostSkills } = await import("../src/host-skills.ts");
  const { createPiHostAdapter } = await import("../src/pi-host-adapter.ts");
  const record = { kind: "skill" as const, source: "notion" as const, sourceId: "owned", sourceScope: "scope", id: "record",
    name: "restored", body: "RESTORED_SOURCE_BODY", snapshotId: snapshot, path: "/immutable/SKILL.md", description: "fixture",
    aliases: [], normalizedName: "restored", normalizedDescription: "fixture", normalizedAliases: [], autoloadEnabled: false,
    locator: { type: "shared_skill" as const, library_id: "lib", skill_id: "skill", page_id: "p", database_id: "db", data_source_id: "ds" } };
  const original = { role: "user", content: "Use the selected Skill." };
  const draft = deferredSourceEntries([{ sourceEntry: { id: "user-1", type: "message", message: original }, messages: [original] }], "user-1",
    [{ role: "custom", customType: "context-broker", content: record.body, details: { records: [sourceDeliveryReceipt(record, record.body)] } }])!;
  expect(draft.entries[0]?.type).toBe("context_edit");
  const edited = draft.entries[0];
  if (edited?.type !== "context_edit" || !edited.replacement) throw new Error("Expected real deferred edit");
  const restored = { ...original, content: edited.replacement.content };
  const receipt = draft.entries[1];
  if (receipt?.type !== "custom") throw new Error("Expected real machine receipt");
  const entries = [{ sourceEntry: { id: "user-1", type: "message" as const, message: restored }, messages: [restored] },
    { sourceEntry: { id: "receipt-1", ...receipt }, messages: [] }];
  expect(sourceBodyLoaded(withSessionSourceReceipts([restored], entries), record)).toBe(true);
  for (const change of ["none", "role", "deleted", "mutate-returned"] as const) {
    const controller = new AbortController(), ledger = createFinalRequestLedger();
    const listeners = new Map<string, Array<(event: never, ctx: never) => unknown>>();
    let confirmed = 0;
    const api = { on(name: string, fn: (event: never, ctx: never) => unknown) { listeners.set(name, [...listeners.get(name) ?? [], fn]); } };
    const ctx = { mode: "rpc" as const, signal: controller.signal, abort: () => controller.abort(),
      model: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1" },
      sessionManager: { getSessionId: () => "restored-session", getBranch: () => [], buildSessionProjection: () => ({ entries, messages: [restored] }) } };
    await installHostSkills(api, { config: {}, getRecords: async () => ({ records: [], failures: [] }), loadRecord: async value => value,
      finalRequests: ledger, confirmDelivery: () => { confirmed++; } }, createPiHostAdapter(api));
    const emit = async (name: string, event: unknown) => {
      let result: { messages?: AgentMessage[] } | undefined;
      for (const fn of listeners.get(name) ?? []) result = await fn(event as never, ctx as never) as typeof result ?? result;
      return result;
    };
    try {
      await emit("agent_start", {});
      const context = await emit("context", { messages: [restored] });
      const final = await emit("context_with_system", { messages: [{ role: "system", content: "rules", toolsAdded: [] }, ...context!.messages!] });
      const messages = final!.messages!;
      expect(messages.some(message => message.customType === "context-broker" && !message.content?.length)).toBe(false);
      const user = messages.find(message => message.role === "user")!;
      expect(user.details).toBeUndefined();
      if (change === "mutate-returned") user.role = "assistant";
      const actual = messages.flatMap(message => message === user && change === "deleted" ? [] : [{
        role: message === user && change === "role" ? "assistant" : message.role === "custom" ? "user" : message.role,
        content: message.content,
      }]);
      await emit("before_provider_request", { payload: payload(actual) });
      expect(controller.signal.aborted).toBe(change !== "none");
      await emit("after_provider_response", { status: 200, headers: {} });
      expect(confirmed).toBe(change === "none" ? 1 : 0);
      expect(ledger.recent().at(-1)?.wireConfirmed).toBe(false);
      if (change !== "none") expect(ledger.recent().at(-1)?.errors).toContain("LOST_SOURCE_RESULT");
    } finally { await emit("session_shutdown", {}); ledger.close(); }
  }
});
