import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createConsumerObservations, currentEvidence } from "../src/consumer-observation";
import { activeSources, confirmActiveSources } from "../src/session-active";
import { persistSessionSelection, sessionSelection } from "../src/session-graph";
import { sourceDeliveryReceipt } from "../src/session-source-snapshot";
import { installHostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import type { PreparedHostGraph } from "../src/prepare-protocol";
import type { AgentMessage, ContentRecord, ExtensionAPI, ExtensionContext, ProjectedSessionEntry, SessionEntry, SkillRecord } from "../src/types";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
  : "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
const record: SkillRecord = {
  id: "shared_skill:bounded:root", source: "notion", sourceId: "bounded", sourceScope: "a".repeat(64),
  name: "root", description: "root", enabled: true, path: "/immutable/root/SKILL.md", aliases: [],
  normalizedName: "root", normalizedDescription: "root", normalizedAliases: [], autoloadEnabled: true,
};

test("FV04 cached evidence reaches its original expiry without becoming a new validation", () => {
  let clock = 109;
  const freshness = { policy: "default", validated_at: new Date(10).toISOString(), max_age_ms: 100, stale: false };
  const evidence = currentEvidence(freshness, "local_cache")!;
  expect(evidence).toEqual({ origin: "cache", validatedAt: 10, validUntil: 110 });
  const current = { ...record, currentObservation: evidence };
  const before = createConsumerObservations(() => 0, () => clock);
  expect(before.observe(current, before.begin())).toBe(true);
  clock = 110;
  const expired = createConsumerObservations(() => 0, () => clock);
  expect(expired.observe(current, expired.begin())).toBe(false);
  clock = 111;
  expect(expired.observe(current, expired.begin())).toBe(false);
  expect(currentEvidence(freshness, "local_cache")).toEqual(evidence);
  // An actual current remote result with max-age zero is a different source
  // of evidence; "expired cache" must not accidentally reject that response.
  expect(expired.observe({ ...record, currentObservation: { origin: "remote", validatedAt: 111, validUntil: 111 } }, expired.begin())).toBe(true);
  expect(expired.observe({ ...record, currentObservation: { origin: "remote", validatedAt: 112, validUntil: 212 } }, expired.begin())).toBe(false);
});

test("FV04 request order resolves equal validation timestamps before publication", () => {
  const observations = createConsumerObservations(() => 0, () => 20);
  const older = observations.begin(), newer = observations.begin();
  const current = { ...record, currentObservation: { origin: "remote" as const, validatedAt: 20, validUntil: 120 } };
  expect(observations.observe(current, newer)).toBe(true);
  expect(observations.deny(record, older, "ACCESS_DENIED")).toBe(false);
  expect(observations.canPublish(record, older)).toBe(false);
  expect(observations.state(record)).toBe("available");
});

test("FV04 an unrecognized source cannot turn a permission unknown into available", () => {
  let clock = 20;
  const observations = createConsumerObservations(() => 0, () => clock);
  observations.deny(record, observations.begin(), "ACCESS_DENIED");
  clock = 30;
  const evidence = currentEvidence({ policy: "default", validated_at: new Date(30).toISOString(), max_age_ms: 100, stale: false }, "unknown_transport");
  expect(evidence).toBeUndefined();
  expect(observations.observe({ ...record, currentObservation: evidence }, observations.begin())).toBe(false);
  expect(observations.state(record)).toBe("denied");
});

function graph(rootVersion: string, requiredVersion: string): PreparedHostGraph {
  const scope = "a".repeat(64);
  const records = [["root", rootVersion], ["required", requiredVersion]].map(([name, version]): SkillRecord => {
    const id = "shared_skill:bounded:" + name;
    const metadata: ContentRecord = {
      id, kind: "skill", name: name!, alias: name!, description: name!, enabled: true, default_context: false,
      entrypoint: "SKILL.md", ref: "skill://" + encodeURIComponent(id) + "/SKILL.md",
      locator: { type: "shared_skill", library_id: "bounded", skill_id: name!,
        page_id: "00000000-0000-4000-8000-000000000001", database_id: "00000000-0000-4000-8000-000000000002", data_source_id: "00000000-0000-4000-8000-000000000003" },
    };
    const body = "Complete " + name + " instructions " + version + ".\n", snapshotId = "s_" + hash(name + ":" + version);
    return { ...metadata, source: "notion", sourceId: "bounded", sourceScope: scope, body, snapshotId, versionId: hash(body),
      path: "/immutable/" + name + "/SKILL.md", aliases: [], normalizedName: name!, normalizedAliases: [], normalizedDescription: name!, autoloadEnabled: false,
      preparationBinding: { record: metadata, scope, snapshot_id: snapshotId, version_id: hash(body), body_sha256: hash(body), ref: metadata.ref + "?snapshot=" + snapshotId } };
  });
  const vector = { version: 1 as const, kind: "observed_version_vector" as const, purpose: "use" as const, scope,
    roots: [records[0]!.id!], required: [{ from: records[0]!.id!, to: records[1]!.id!, ref: records[1]!.preparationBinding!.ref }],
    bindings: records.map(item => item.preparationBinding!) };
  return { purpose: "use", scope, sourceId: "bounded", roots: vector.roots, records, bindings: vector.bindings,
    lock: { ...vector, sha256: hash(canonical(vector)) }, budget: { maxNodes: 2, maxDepth: 1, maxInstructionBytes: 1000, maxContextBytes: 2000 },
    usage: { prepared_nodes: 2, instruction_bytes: 100, context_bytes: 100, max_depth: 1 } };
}
const delivery = (records: readonly SkillRecord[]): AgentMessage[] => records.map(item => ({
  role: "custom", customType: "context-broker", content: item.body, details: { records: [sourceDeliveryReceipt(item, item.body!)] },
}));

test("FV05 root and Requires retain independent pins and only the effective branch supplies state", () => {
  const branch: SessionEntry[] = [];
  const ctx: ExtensionContext = { sessionManager: {
    getBranch: () => branch,
    getEntries() { throw new Error("All history cannot supply the current branch"); },
  } };
  const api: ExtensionAPI = { on() {}, appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); } };
  const first = graph("A", "B"), second = graph("B", "A");
  persistSessionSelection(api, ctx, [first], "extend");
  confirmActiveSources(api, ctx, first.records, delivery(first.records));
  const branchPoint = branch.length;
  persistSessionSelection(api, ctx, [second], "replace");
  confirmActiveSources(api, ctx, second.records, delivery(second.records));
  const chosen = [...sessionSelection(ctx).scopes.values()][0]!;
  expect([...chosen.bindings.values()].map(item => item.snapshot_id)).toEqual(second.records.map(item => item.snapshotId!));
  expect(second.records[0]!.snapshotId).not.toBe(second.records[1]!.snapshotId);
  expect([...activeSources(ctx).sources.values()].map(item => item.snapshotId)).toEqual(second.records.map(item => item.snapshotId!));
  branch.splice(branchPoint);
  expect([...activeSources(ctx).sources.values()].map(item => item.snapshotId)).toEqual(first.records.map(item => item.snapshotId!));
  expect([...sessionSelection(ctx).scopes.values()][0]!.bindings.get(first.records[1]!.id!)!.snapshot_id).toBe(first.records[1]!.snapshotId!);
  const sibling: ExtensionContext = { sessionManager: { getBranch: () => [] } };
  expect(activeSources(sibling).sources.size).toBe(0);
});

test("FV05 complete bodies from different graph versions cannot confirm the selected vector", () => {
  const branch: SessionEntry[] = [], ctx: ExtensionContext = { sessionManager: { getBranch: () => branch } };
  const api: ExtensionAPI = { on() {}, appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); } };
  const selected = graph("A", "B"), other = graph("A", "A");
  persistSessionSelection(api, ctx, [selected], "extend");
  const mixed = [selected.records[0]!, other.records[1]!];
  confirmActiveSources(api, ctx, mixed, delivery(mixed));
  expect(activeSources(ctx).sources.size).toBe(0);
  confirmActiveSources(api, ctx, selected.records, delivery(selected.records));
  expect(activeSources(ctx).sources.size).toBe(2);
});

async function pendingProvider() {
  const listeners = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const controller = new AbortController(), entries: ProjectedSessionEntry[] = [], state = { sessionId: "original" };
  const api: ExtensionAPI = {
    on(name, handler) { listeners.set(name, [...listeners.get(name) ?? [], handler]); },
    appendEntry(customType, data) { entries.push({ sourceEntry: { type: "custom", customType, data, id: "custom-" + entries.length }, messages: [] }); },
  };
  const messages = () => entries.flatMap(entry => entry.messages);
  const ctx: ExtensionContext = { signal: controller.signal, abort: () => controller.abort(), sessionManager: {
    getSessionId: () => state.sessionId, getBranch: () => entries.map(entry => entry.sourceEntry),
    buildSessionProjection: () => ({ entries, messages: messages() }),
  } };
  await installHostSkills(api, {
    config: {}, getRecords: async () => ({ records: [], failures: [] }), loadRecord: async item => item,
    needsPreflightPrompt: text => text.includes("$task"), taskPrompt: async text => text + "\n\nFV05_SOURCE",
  }, createPiHostAdapter(api));
  const emit = async (name: string, event: unknown = {}) => {
    const results = [];
    for (const handler of listeners.get(name) ?? []) results.push(await handler(event as never, ctx));
    return results;
  };
  await emit("input", { source: "rpc", text: "$task execute" });
  await emit("before_agent_start", { prompt: "$task execute", systemPrompt: "base" });
  await emit("agent_start");
  const user: AgentMessage = { role: "user", content: "$task execute" };
  entries.push({ sourceEntry: { type: "message", id: "user", message: user }, messages: [user] });
  await emit("context", { messages: messages() });
  await emit("before_provider_request", { type: "before_provider_request", payload: {} });
  return { entries, state, controller, emit };
}

test("FV05 a late provider callback cannot confirm a different session identity", async () => {
  const f = await pendingProvider();
  try {
    f.state.sessionId = "replacement";
    await expect(f.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} })).rejects.toThrow(/cancel/i);
    expect(f.controller.signal.aborted).toBe(true);
    expect(f.entries).toHaveLength(1);
  } finally {
    await f.emit("agent_end");
    await f.emit("session_shutdown");
  }
});

test("FV05 rewinding to a different user entry cannot attach the old delivery proof", async () => {
  const f = await pendingProvider();
  try {
    await f.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} });
    const foreign: AgentMessage = { role: "user", content: "Different branch input" };
    const assistant: AgentMessage = { role: "assistant", content: "completed" };
    f.entries.splice(0, 1,
      { sourceEntry: { type: "message", id: "foreign-user", message: foreign }, messages: [foreign] },
      { sourceEntry: { type: "message", id: "assistant", message: assistant }, messages: [assistant] });
    const before = JSON.stringify(f.entries);
    const result = await f.emit("turn_end", { type: "turn_end", turnIndex: 0, outcome: "completed", entries: [], continue: false,
      messageEntryId: "assistant", toolResultEntryIds: [],
      context: { contextEntries: f.entries, contextMessages: f.entries.flatMap(entry => entry.messages) } });
    expect(result.filter(Boolean)).toEqual([]);
    expect(JSON.stringify(f.entries)).toBe(before);
  } finally {
    await f.emit("agent_end");
    await f.emit("session_shutdown");
  }
});
