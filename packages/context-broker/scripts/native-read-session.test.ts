import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deduplicateSourceReads, nativeReadReceipt, nativeReadSnapshot, sessionSourceSnapshot } from "../src/session-source-snapshot";
import { hasLoadedSkill } from "../src/index";
import { installHostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { recordIdentity } from "../src/discovery-records";
import type { AgentMessage, ExtensionAPI, ExtensionContext, SkillRecord } from "../src/types";
const a = "s_" + "a".repeat(64), b = "s_" + "b".repeat(64);
const record = { kind: "skill", sourceId: "notion", sourceScope: "scope", source: "notion", id: "record", name: "example", token: "notion/example", path: "/immutable/SKILL.md", metadataIndexPath: "/metadata/SKILL.md", description: "Example", aliases: [], normalizedName: "example", normalizedDescription: "example", normalizedAliases: [], autoloadEnabled: false, body: "---\nname: example\n---\nExact native instructions.\n", snapshotId: a, locator: { type: "shared_skill", library_id: "lib", skill_id: "skill", page_id: "p", database_id: "d", data_source_id: "ds" } } satisfies SkillRecord;
const result = (): AgentMessage => ({ role: "toolResult", toolName: "read", toolCallId: "read-1", isError: false, content: [{ type: "text", text: record.body }], details: { contextBrokerRead: nativeReadReceipt(record, "read-1", record.body) } });

test("a complete successful native read counts as loaded without injecting a second body", () => {
  const message = result();
  expect(nativeReadSnapshot([message], record)).toBe(a);
  expect(hasLoadedSkill([message], record)).toBe(true);
  expect(sessionSourceSnapshot([message], record)).toBe(a);
});
test("partial, failed, detached, forged text and cross-scope receipts cannot suppress activation", () => {
  expect(nativeReadReceipt(record, "id", record.body.slice(0, 10))).toBeUndefined();
  for (const message of [{ ...result(), content: "partial" }, { ...result(), isError: true }, { ...result(), role: "user" }, { ...result(), toolCallId: "different" }, { ...result(), details: undefined }]) expect(hasLoadedSkill([message], record)).toBe(false);
  expect(hasLoadedSkill([result()], { ...record, sourceScope: "other-credential" })).toBe(false);
  expect(sessionSourceSnapshot([], record)).toBeUndefined();
});
test("the pinned snapshot comes from effective tool bytes rather than today's metadata", () => {
  expect(sessionSourceSnapshot([result()], { ...record, snapshotId: b, body: "new upstream" })).toBe(a);
  const second = { ...result(), details: { contextBrokerRead: nativeReadReceipt({ ...record, snapshotId: b }, "read-1", record.body) } };
  expect(() => sessionSourceSnapshot([result(), second], record)).toThrow("Conflicting");
});
test("native command receipts require their actual user body, and dollar receipts require their content", () => {
  const text = "<skill>Exact original instructions</skill>", proof = { role: "custom", customType: "context-broker", content: [], details: { nativePromptSha256: createHash("sha256").update(text).digest("hex"), records: [{ identity: recordIdentity(record), loaded: true, snapshotId: a }] } } as AgentMessage;
  expect(sessionSourceSnapshot([proof], record)).toBeUndefined();
  expect(sessionSourceSnapshot([{ role: "user", content: text }, proof], record)).toBe(a);
  expect(sessionSourceSnapshot([{ ...proof, details: { records: proof.details && (proof.details as Record<string, unknown>).records } }], record)).toBeUndefined();
});
test("Pi native invocation uses the immutable resource directory, not a temporary host alias", async () => {
  const adapter = createPiHostAdapter({ on() {} } as ExtensionAPI);
  const prompt = await adapter.buildPrompt(record, "task", "", record);
  expect(prompt).toContain('location="/immutable/SKILL.md"');
  expect(prompt).toContain("References are relative to /immutable");
  expect(prompt).not.toContain("/metadata");
});
test("repeated actual native reads keep one provider body without mutating stored tool results", () => {
  const first = result(), second = { ...result(), toolCallId: "read-2", details: { contextBrokerRead: nativeReadReceipt(record, "read-2", record.body) } };
  const messages = [first, second];
  const projected = deduplicateSourceReads(messages);
  expect(JSON.stringify(projected).split("Exact native instructions.").length - 1).toBe(1);
  expect(projected[1]?.toolCallId).toBe("read-2");
  expect(messages[1]?.content).toEqual(second.content);
  expect(nativeReadSnapshot(messages, record)).toBe(a);
  // If compaction removes the original, the remaining full stored read becomes
  // the one provider-visible copy again.
  expect(deduplicateSourceReads([second])[0]).toBe(second);
});
test("trusted native or dollar injection coalesces rereads, never user XML or foreign scope", () => {
  const injected: AgentMessage = { role: "custom", customType: "context-broker", content: record.body, details: { records: [{ identity: recordIdentity(record), snapshotId: a, loaded: true }] } };
  expect(JSON.stringify(deduplicateSourceReads([injected, result()])).split("Exact native instructions.").length - 1).toBe(1);
  const user: AgentMessage = { role: "user", content: record.body };
  expect(deduplicateSourceReads([user, result()])[1]?.content).toEqual(result().content);
  const foreign = { ...result(), details: { contextBrokerRead: nativeReadReceipt({ ...record, sourceScope: "different" }, "read-1", record.body) } };
  expect(deduplicateSourceReads([injected, foreign])[1]).toBe(foreign);
});
test("real hook sequence marks only the completed entry result and reuses its active pin", async () => {
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>(), messages: AgentMessage[] = [], loads: Array<string | undefined> = [];
  const api = { on(name: string, listener: (event: never, ctx: ExtensionContext) => unknown) { events.set(name, [...events.get(name) ?? [], listener]); } } as ExtensionAPI;
  const ctx: ExtensionContext = { cwd: "/controlled", hasUI: false, mode: "rpc", sessionManager: { getSessionId: () => "session", getEntries: () => [], buildSessionContext: () => ({ messages }) } };
  const metadata = { ...record, metadataIndexPath: undefined, body: undefined };
  const host = await installHostSkills(api, { config: {}, getRecords: async () => ({ records: [metadata], failures: [] }), loadRecord: async (_r, _signal, pin) => { loads.push(pin); return record; }, isLoaded: (r) => hasLoadedSkill(messages, r), sessionSnapshot: (r) => sessionSourceSnapshot(messages, r) }, createPiHostAdapter(api));
  async function emit(name: string, event: unknown) { const results=[];for (const listener of events.get(name) ?? []) results.push(await listener(event as never, ctx));return results; }
  const input = { path: metadata.path };
  await emit("tool_call", { toolName: "read", toolCallId: "read-1", input });
  const returned = await emit("tool_result", { toolName: "read", toolCallId: "read-1", input, content: [{ type: "text", text: record.body }], isError: false, details: { original: true } });
  const annotated = returned.find((value): value is { details: unknown } => !!value && typeof value === "object" && "details" in value);
  expect(annotated).toBeDefined();
  expect((annotated!.details as Record<string, unknown>).original).toBe(true);
  messages.push({ ...result(), details: annotated!.details });
  await host.activate(metadata, ctx);
  expect(loads).toEqual([undefined]);
  await emit("session_start", { type: "session_start" }); await host.refresh(ctx);
  await host.activate(metadata, ctx);
  expect(loads).toEqual([undefined, a]);
  messages.length = 0;
  await emit("session_switch", { type: "session_switch" }); await host.refresh(ctx);
  await host.activate(metadata, ctx);
  expect(loads).toEqual([undefined, a, undefined]);
});
