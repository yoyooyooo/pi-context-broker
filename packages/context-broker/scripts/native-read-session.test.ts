import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeReference } from "../src/native-reference";
import { deduplicateSourceReads, nativeReadReceipt, nativeReadSnapshot, sessionSourceSnapshot, sourceDeliveryReceipt, sourceMessageText, sessionSourceBindings, projectSelectedSourceMessages } from "../src/session-source-snapshot";
import { hasLoadedSkill } from "../src/index";
import { installHostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { recordIdentity } from "../src/discovery-records";
import { compileResourceRead } from "../src/resource-read-projection";
import { SourceError, SourceReferenceAmbiguity } from "../src/notion-source";
import type { AgentMessage, ExtensionAPI, ExtensionContext, SessionEntry, SkillRecord } from "../src/types";
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
  expect(hasLoadedSkill([{ ...result(), details: { contextBrokerRead: { ...nativeReadReceipt(record, "read-1", record.body), loaded: false } } }], record)).toBe(false);
  for (const toolCallId of [undefined, ""]) expect(hasLoadedSkill([{ ...result(), toolCallId,
    details: { contextBrokerRead: { ...nativeReadReceipt(record, "read-1", record.body), toolCallId } } }], record)).toBe(false);
  expect(hasLoadedSkill([result()], { ...record, sourceScope: "other-credential" })).toBe(false);
  expect(sessionSourceSnapshot([], record)).toBeUndefined();
});
test("v3 native receipts prove only the exact full prefix and retain the appended reference directory", () => {
  const footer = "\n<context-broker-resources>S1: complete entry; R1: guide</context-broker-resources>";
  const content = record.body + footer, proof = nativeReadReceipt(record, "prefix-read", content)!;
  expect(proof.version).toBe(3);
  expect(proof.delivery).toEqual({ start: 0, end: record.body.length, encoding: "raw" });
  const message: AgentMessage = { ...result(), toolCallId: "prefix-read", content, details: { contextBrokerRead: proof } };
  expect(hasLoadedSkill([message], record)).toBe(true);
  const duplicate: AgentMessage = { ...message, toolCallId: "second-read", details: { contextBrokerRead: nativeReadReceipt(record, "second-read", content) } };
  const stored = JSON.stringify([message, duplicate]);
  const projected = deduplicateSourceReads([message, duplicate]);
  expect(sourceMessageText(projected[0]?.content)).toBe(content);
  expect(sourceMessageText(projected[1]?.content)).toBe("Already loaded." + footer);
  expect(hasLoadedSkill([projected[1]!], record)).toBe(false);
  expect(projected.map(value => value.toolCallId)).toEqual(["prefix-read", "second-read"]);
  expect(JSON.stringify([message, duplicate])).toBe(stored);
  const retiredBinding = { record: { ...record, alias: record.name, enabled: true, default_context: false, entrypoint: "SKILL.md", ref: "skill://record/SKILL.md" },
    scope: "scope", snapshot_id: a, version_id: createHash("sha256").update(record.body).digest("hex"), body_sha256: createHash("sha256").update(record.body).digest("hex"), ref: "skill://record/SKILL.md?snapshot=" + a };
  const retired = projectSelectedSourceMessages([message], { scopes: new Map([["scope", {
    scope: "scope", bindings: new Map(), retired: new Map([[record.id, retiredBinding]]), graphs: [], selectionId: "new",
  }]]) });
  expect(sourceMessageText(retired[0]?.content)).not.toContain(record.body);
  expect(sourceMessageText(retired[0]?.content).endsWith(footer)).toBe(true);
  expect(nativeReadReceipt(record, "not-prefix", "label\n" + record.body + footer)).toBeUndefined();
  for (const invalid of [
    { ...message, role: "user" }, { ...message, toolCallId: "different" }, { ...message, content: "summary" + footer },
    { ...message, content: content.slice(1) },
    { ...message, details: { contextBrokerRead: { ...proof, delivery: { ...proof.delivery, start: 1 } } } },
    { ...message, details: { contextBrokerRead: { ...proof, delivery: { ...proof.delivery, end: record.body.length - 1 } } } },
  ]) expect(hasLoadedSkill([invalid], record)).toBe(false);
});
test("the pinned snapshot comes from effective tool bytes rather than today's metadata", () => {
  expect(sessionSourceSnapshot([result()], { ...record, snapshotId: b, body: "new upstream" })).toBe(a);
  const second = { ...result(), details: { contextBrokerRead: nativeReadReceipt({ ...record, snapshotId: b }, "read-1", record.body) } };
  expect(() => sessionSourceSnapshot([result(), second], record)).toThrow("Conflicting");
});
test("native command receipts require their actual user body, and dollar receipts require their content", () => {
  const text = "<skill>" + record.body + "</skill>", proof = { role: "custom", customType: "context-broker", content: [], details: { nativePromptSha256: createHash("sha256").update(text).digest("hex"), records: [sourceDeliveryReceipt(record, text)] } } as AgentMessage;
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
  expect(sourceMessageText(projected[1]?.content)).toBe("Already loaded.");
  expect(projected[1]?.details).toMatchObject({ contextBrokerRead: { loaded: false } });
  expect(projected[1]?.toolCallId).toBe("read-2");
  expect(messages[1]?.content).toEqual(second.content);
  expect(nativeReadSnapshot(messages, record)).toBe(a);
  // If compaction removes the original, the remaining full stored read becomes
  // the one provider-visible copy again.
  expect(deduplicateSourceReads([second])[0]).toBe(second);
});

test("raw, XML and JSON instruction deliveries retain one source and compact only the repeated span", () => {
  const source = { ...record, body: '\ufeff作者 <body> & "quoted" \\ 🧭\r\nKeep every rule.\r\n' };
  for (const encoding of ["raw", "xml", "json"] as const) {
    const encoded = encoding === "xml" ? source.body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      : encoding === "json" ? JSON.stringify(source.body).slice(1, -1) : source.body;
    const prefix = encoding === "json" ? '{"content":"' : "<source>";
    const suffix = encoding === "json" ? '","after":"preserved"}' : "</source>after";
    const content = prefix + encoded + suffix;
    const first: AgentMessage = { role: "custom", customType: "context-broker", content,
      details: { records: [sourceDeliveryReceipt(source, content, encoding, prefix.length)] } };
    const second = structuredClone(first), messages = [first, second], stored = JSON.stringify(messages);
    const projected = deduplicateSourceReads(messages);
    expect(sourceMessageText(projected[0]?.content)).toBe(content);
    expect(sourceMessageText(projected[1]?.content)).toBe(prefix + "Already loaded." + suffix);
    expect(hasLoadedSkill([projected[0]!], source)).toBe(true);
    expect(hasLoadedSkill([projected[1]!], source)).toBe(false);
    expect(deduplicateSourceReads(projected)).toBe(projected);
    expect(deduplicateSourceReads([second])[0]).toBe(second);
    expect(JSON.stringify(messages)).toBe(stored);
  }
});

test("native confirmation stays compact for tiny bodies and cannot become a new complete delivery", () => {
  for (const body of ["x", "Already loaded."]) for (const footer of ["", "\n<skill-directory>fixed resources</skill-directory>"]) {
    const source = { ...record, body }, content = body + footer;
    const messages: AgentMessage[] = ["first", "second"].map(toolCallId => ({ role: "toolResult", toolName: "read", toolCallId, content,
      details: { contextBrokerRead: nativeReadReceipt(source, toolCallId, content) } }));
    const stored = JSON.stringify(messages), projected = deduplicateSourceReads(messages);
    expect(sourceMessageText(projected[0]?.content)).toBe(content);
    expect(sourceMessageText(projected[1]?.content)).toBe("Already loaded." + footer);
    expect(hasLoadedSkill([projected[0]!], source)).toBe(true);
    expect(hasLoadedSkill([projected[1]!], source)).toBe(false);
    expect(deduplicateSourceReads(projected)).toBe(projected);
    const fresh: AgentMessage = { ...messages[1]!, toolCallId: "fresh", details: { contextBrokerRead: nativeReadReceipt(source, "fresh", content) } };
    expect(deduplicateSourceReads([projected[1]!, fresh])[1]).toBe(fresh);
    expect(deduplicateSourceReads([messages[1]!])[0]).toBe(messages[1]);
    expect(hasLoadedSkill([messages[1]!], source)).toBe(true);
    expect(JSON.stringify(messages)).toBe(stored);
  }
});

test("native compaction keeps different scopes, pins and bytes and does not shorten partial or failed reads", () => {
  for (const source of [{ ...record, sourceScope: "other" }, { ...record, snapshotId: b }, { ...record, body: "Different complete instructions.\n" }]) {
    const second: AgentMessage = { role: "toolResult", toolName: "read", toolCallId: "second", content: source.body,
      details: { contextBrokerRead: nativeReadReceipt(source, "second", source.body) } };
    const messages = [result(), second]; expect(deduplicateSourceReads(messages)).toBe(messages);
  }
  const second: AgentMessage = { ...result(), toolCallId: "second", details: { contextBrokerRead: nativeReadReceipt(record, "second", record.body) } };
  for (const changed of [{ ...second, content: "partial" }, { ...second, isError: true }, { ...second, toolCallId: "detached" },
    { ...second, details: undefined }, { ...second, content: [{ type: "image", data: "AA==" }] }]) {
    const messages: AgentMessage[] = [result(), changed]; expect(deduplicateSourceReads(messages)).toBe(messages);
  }
});
test("trusted native or dollar injection coalesces rereads, never user XML or foreign scope", () => {
  const injected: AgentMessage = { role: "custom", customType: "context-broker", content: record.body, details: { records: [sourceDeliveryReceipt(record, record.body)] } };
  expect(JSON.stringify(deduplicateSourceReads([injected, result()])).split("Exact native instructions.").length - 1).toBe(1);
  const user: AgentMessage = { role: "user", content: record.body };
  expect(deduplicateSourceReads([user, result()])[1]?.content).toEqual(result().content);
  const foreign = { ...result(), details: { contextBrokerRead: nativeReadReceipt({ ...record, sourceScope: "different" }, "read-1", record.body) } };
  expect(deduplicateSourceReads([injected, foreign])[1]).toBe(foreign);
  expect(hasLoadedSkill([{ ...injected, content: record.body.slice(5) }], record)).toBe(false);
  expect(hasLoadedSkill([{ ...injected, content: "Compacted instructions." }], record)).toBe(false);
  expect(hasLoadedSkill([injected], { ...record, sourceId: "other-namespace" })).toBe(true);
  expect(hasLoadedSkill([injected], { ...record, body: record.body + "changed" })).toBe(false);
});

function resourceResult(toolCallId: string, { scope = "scope", id = "shared_skill:lib:skill", snapshotId = a, fileId = "guide", body = "Exact supporting resource.\n" } = {}) {
  const path = "references/guide.md";
  return {
    role: "toolResult", toolName: "read", toolCallId, isError: false, content: [{ type: "text", text: body }],
    details: { contextBrokerResource: {
      version: 1, toolCallId, id, scope, snapshot_id: snapshotId, file_id: fileId, path,
      ref: "skill://" + encodeURIComponent(id) + "/" + path + "?snapshot=" + snapshotId + "&file_id=" + encodeURIComponent(fileId),
      bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"),
      delivered_complete_text: true, loaded: false,
    } },
  } satisfies AgentMessage;
}

test("repeated complete resource reads retain one provider body and every stored tool result", () => {
  const messages = [resourceResult("resource-1"), resourceResult("resource-2"), resourceResult("resource-3")];
  const stored = JSON.stringify(messages), body = sourceMessageText(messages[0]!.content);
  const projected = deduplicateSourceReads(messages);
  expect(projected.filter(message => sourceMessageText(message.content) === body)).toHaveLength(1);
  expect(sourceMessageText(projected[1]?.content)).toBe("Already available.");
  expect(projected.map(message => message.toolCallId)).toEqual(["resource-1", "resource-2", "resource-3"]);
  expect(projected[1]?.details).toEqual({ contextBrokerResource: { ...messages[1]!.details.contextBrokerResource, delivered_complete_text: false } });
  expect(JSON.stringify(messages)).toBe(stored);
  expect(deduplicateSourceReads(projected)).toBe(projected);
  // Compaction can discard earlier copies; the remaining real read still owns its full body.
  expect(deduplicateSourceReads([messages[2]!])[0]).toBe(messages[2]);
  const owner = { ...record, id: "shared_skill:lib:skill" };
  for (const active of [messages, projected]) {
    expect(hasLoadedSkill(active, owner)).toBe(false);
    expect(sessionSourceSnapshot(active, owner)).toBeUndefined();
    expect(sessionSourceBindings(active, "scope")).toEqual([]);
  }
});

test("scalar resource confirmations never attest their own text and empty resources stay empty", () => {
  for (const body of ["x", "Already available."]) {
    const messages = [resourceResult("first", { body }), resourceResult("second", { body })], stored = JSON.stringify(messages);
    const projected = deduplicateSourceReads(messages);
    expect(sourceMessageText(projected[0]?.content)).toBe(body);
    expect(sourceMessageText(projected[1]?.content)).toBe("Already available.");
    expect(projected[1]?.details).toMatchObject({ contextBrokerResource: { delivered_complete_text: false, loaded: false } });
    expect(deduplicateSourceReads(projected)).toBe(projected);
    const fresh = resourceResult("fresh", { body });
    expect(deduplicateSourceReads([projected[1]!, fresh])[1]).toBe(fresh);
    expect(deduplicateSourceReads([messages[1]!])[0]).toBe(messages[1]);
    expect(JSON.stringify(messages)).toBe(stored);
  }
  const empty = [resourceResult("empty-first", { body: "" }), resourceResult("empty-second", { body: "" })];
  expect(deduplicateSourceReads(empty)).toBe(empty);
  expect(empty.every(message => sourceMessageText(message.content) === "")).toBe(true);
});

test("resource deduplication preserves different scopes, owners, snapshots, File IDs and bodies", () => {
  for (const identity of [{ scope: "other" }, { id: "shared_skill:lib:other" }, { snapshotId: b }, { fileId: "other" }, { body: "Changed resource.\n" }]) {
    const messages = [resourceResult("first"), resourceResult("second", identity)];
    expect(deduplicateSourceReads(messages)).toBe(messages);
  }
});

test("batch resource receipts never load or rebind a main even when the resource contains identical instructions", () => {
  const owner = { ...record, id: "shared_skill:lib:skill" }, body = record.body, path = "references/instructions.md";
  const ref = "skill://" + encodeURIComponent(owner.id) + "/" + path + "?snapshot=" + a + "&file_id=instructions";
  const batch = { selection: { scope: "scope", owner: owner.id, snapshot_id: a, version_id: "a".repeat(64) },
    files: [{ requested_ref: ref, ref, file_id: "instructions", path, bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex"), encoding: "utf8" as const, content: body }] };
  const messages = ["batch-1", "batch-2"].map(toolCallId => ({ role: "toolResult", toolName: "read", toolCallId,
    ...compileResourceRead({ toolCallId, batch, modelRefs: [ref], maxContextBytes: 1048576 }) } satisfies AgentMessage));
  for (const history of [messages, deduplicateSourceReads(messages)]) {
    expect(hasLoadedSkill(history, owner)).toBe(false);
    expect(sessionSourceSnapshot(history, owner)).toBeUndefined();
    expect(sessionSourceBindings(history, "scope")).toEqual([]);
  }
});

test("incomplete or mismatched resource receipts never suppress a read", () => {
  const first = resourceResult("first"), second = resourceResult("second"), proof = second.details.contextBrokerResource;
  const changedProof = (changes: Record<string, unknown>): AgentMessage => ({ ...second, details: { contextBrokerResource: { ...proof, ...changes } } });
  const invalid: AgentMessage[] = [
    { ...second, content: "partial" }, { ...second, isError: true }, { ...second, role: "user" },
    { ...second, toolName: "other" }, { ...second, toolCallId: "different" }, { ...second, details: undefined },
    { ...second, content: [...second.content, { type: "image", data: "AA==" }] },
    changedProof({ delivered_complete_text: false }), changedProof({ loaded: true }), changedProof({ version: 2 }),
    changedProof({ scope: "" }), changedProof({ bytes: proof.bytes + 1 }), changedProof({ sha256: "0".repeat(64) }),
    changedProof({ ref: proof.ref.replace("lib%3Askill", "lib%3Aforeign") }),
    changedProof({ ref: proof.ref.replace(a, b) }), changedProof({ ref: proof.ref.replace("file_id=guide", "file_id=foreign") }),
    changedProof({ path: "references/other.md" }),
  ];
  for (const message of invalid) {
    const messages = [first, message];
    expect(deduplicateSourceReads(messages)).toBe(messages);
  }
});


function pathResourceResult(toolCallId: string, identity: { scope?: string; id?: string; snapshotId?: string; path?: string; body?: string } = {}) {
  const result = resourceResult(toolCallId, identity), proof = result.details.contextBrokerResource;
  const path = identity.path ?? proof.path;
  return { ...result, details: { contextBrokerResource: { ...proof, file_id: undefined, path,
    ref: "skill://" + encodeURIComponent(proof.id) + "/" + path + "?snapshot=" + proof.snapshot_id,
  } } };
}

test("verified resources without File IDs deduplicate by exact owner, snapshot and path without loading the main", () => {
  const messages = [pathResourceResult("path-1"), pathResourceResult("path-2"), pathResourceResult("path-3")];
  const stored = JSON.stringify(messages), body = sourceMessageText(messages[0]!.content);
  for (const history of [messages, JSON.parse(stored) as AgentMessage[]]) {
    const projected = deduplicateSourceReads(history);
    expect(projected.filter(message => sourceMessageText(message.content) === body)).toHaveLength(1);
    expect(projected.map(message => message.toolCallId)).toEqual(["path-1", "path-2", "path-3"]);
    expect(projected[1]?.details).toEqual({ contextBrokerResource: { ...messages[1]!.details.contextBrokerResource, delivered_complete_text: false } });
    expect(deduplicateSourceReads(projected)).toBe(projected);
    expect(deduplicateSourceReads([history[2]!])[0]).toBe(history[2]);
    const owner = { ...record, id: "shared_skill:lib:skill" };
    expect(hasLoadedSkill(projected, owner)).toBe(false);
    expect(sessionSourceSnapshot(projected, owner)).toBeUndefined();
    expect(sessionSourceBindings(projected, "scope")).toEqual([]);
  }
  expect(JSON.stringify(messages)).toBe(stored);
});

test("path-only resource identity keeps scopes, owners, snapshots, paths, hashes and explicit File IDs separate", () => {
  for (const identity of [{ scope: "other" }, { id: "shared_skill:lib:other" }, { snapshotId: b }, { path: "references/other.md" }, { body: "Changed resource.\n" }]) {
    const messages = [pathResourceResult("first"), pathResourceResult("second", identity)];
    expect(deduplicateSourceReads(messages)).toBe(messages);
  }
  const messages = [pathResourceResult("path"), resourceResult("file", { fileId: "references/guide.md" })];
  expect(deduplicateSourceReads(messages)).toBe(messages);
  const reverse = [...messages].reverse();
  expect(deduplicateSourceReads(reverse)).toBe(reverse);
});

test("path fallback rejects null, invalid and mismatched File IDs and incomplete resource proofs", () => {
  const first = pathResourceResult("first"), second = pathResourceResult("second"), proof = second.details.contextBrokerResource;
  const changed = (fields: Record<string, unknown>): AgentMessage => ({ ...second, details: { contextBrokerResource: { ...proof, ...fields } } });
  const invalid: AgentMessage[] = [
    ...[null, "", 0, false, [], {}].map(file_id => changed({ file_id })),
    changed({ file_id: "guide" }), changed({ ref: proof.ref + "&file_id=guide" }),
    changed({ file_id: null, ref: proof.ref + "&file_id=null" }),
    changed({ path: "", ref: "skill://" + encodeURIComponent(proof.id) + "/?snapshot=" + proof.snapshot_id }),
    changed({ path: "references/other.md" }), changed({ ref: proof.ref.replace(a, b) }),
    changed({ ref: proof.ref.replace("lib%3Askill", "lib%3Aforeign") }),
    changed({ delivered_complete_text: false }), changed({ loaded: true }),
    changed({ bytes: proof.bytes + 1 }), changed({ sha256: "0".repeat(64) }),
    { ...second, content: "partial" }, { ...second, isError: true }, { ...second, toolCallId: "detached" },
  ];
  for (const value of invalid) {
    const messages = [first, value];
    expect(deduplicateSourceReads(messages)).toBe(messages);
  }
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

test("cold native refs select an outside-View owner and resolve stable File ID in the requested snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "broker-exact-read-"));
  await mkdir(join(root, "moved"));
  await writeFile(join(root, "SKILL.md"), record.body);
  await writeFile(join(root, "moved/resource.md"), "RESOURCE");
  const owner = { ...record, id: "shared_skill:lib:skill", ref: "skill://shared_skill%3Alib%3Askill/SKILL.md", path: join(root, "SKILL.md"), metadataIndexPath: undefined, defaultDiscovery: false, fileBindings: [
    { file_id: "main", page_id: "p", path: "SKILL.md" },
    { file_id: "resource", page_id: "r", path: "moved/resource.md" },
  ] };
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const api = { on(name: string, listener: (event: never, ctx: ExtensionContext) => unknown) { events.set(name, [...events.get(name) ?? [], listener]); } } as ExtensionAPI;
  const pins: Array<string | undefined> = [];
  const ctx: ExtensionContext = { cwd: root, hasUI: false, mode: "rpc" };
  await installHostSkills(api, {
    config: {}, getRecords: async () => ({ records: [{ ...owner, body: undefined }], failures: [] }),
    loadRecord: async (_record, _signal, pin) => { pins.push(pin); return owner; },
  }, createPiHostAdapter(api));
  async function read(path: string) {
    const input = { path };
    const values = [];
    for (const listener of events.get("tool_call") ?? []) values.push(await listener({ toolName: "read", toolCallId: "exact", input } as never, ctx));
    return { input, values };
  }
  const cold = await read("skill://shared_skill%3Alib%3Askill/old.md?snapshot=" + a + "&file_id=resource");
  expect(cold.input.path).toBe(await realpath(join(root, "moved/resource.md")));
  expect(pins).toEqual([a]);
  const missing = await read("skill://shared_skill%3Alib%3Askill/SKILL.md?snapshot=" + a + "&file_id=foreign");
  expect(JSON.stringify(missing.values)).toContain("SHARED_FILE_BINDING_UNAVAILABLE");
  const unknown = await read("skill://shared_skill%3Alib%3Askill/SKILL.md?scope=other");
  expect(JSON.stringify(unknown.values)).toContain("SOURCE_REFERENCE_INVALID");
  const oldAlias = await read("skill://same-name/SKILL.md");
  expect(JSON.stringify(oldAlias.values)).toContain("SOURCE_REFERENCE_MISSING");
  expect(() => parseNativeReference(owner.ref + "?snapshot=" + a + "&snapshot=" + b)).toThrow();
});


test("precise references bypass unrelated metadata failure without an Agent list step", async () => {
  const root = await mkdtemp(join(tmpdir(), "broker-exact-lookup-"));
  await writeFile(join(root, "SKILL.md"), record.body);
  const owner = { ...record, id: "shared_skill:lib:skill", ref: "skill://shared_skill%3Alib%3Askill/SKILL.md", entrypoint: "SKILL.md", path: join(root, "SKILL.md"), metadataIndexPath: undefined, defaultDiscovery: false };
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const api = { on(name: string, listener: (event: never, ctx: ExtensionContext) => unknown) { events.set(name, [...events.get(name) ?? [], listener]); } } as ExtensionAPI;
  const ctx: ExtensionContext = { cwd: root, hasUI: false, mode: "rpc" };
  const pins: Array<string | undefined> = [];
  let lookups = 0;
  await installHostSkills(api, {
    config: {},
    getRecords: async () => { throw Object.assign(new Error("Unrelated invalid catalog"), { code: "SOURCE_DISCOVERY_INVALID" }); },
    lookupReference: async () => { lookups++; return { records: [{ ...owner, body: undefined }], failures: [{ sourceId: "other", namespace: "other", type: "notion", code: "NOTION_FORBIDDEN", message: "Unrelated source cannot be listed" }] }; },
    loadRecord: async (_record, _signal, pin) => { pins.push(pin); return owner; },
  }, createPiHostAdapter(api));
  const input = { path: owner.ref + "?snapshot=" + a };
  const replies = [];
  for (const listener of events.get("tool_call") ?? []) replies.push(await listener({ toolName: "read", toolCallId: "exact-unrelated", input } as never, ctx));
  expect(replies.some(reply => reply && typeof reply === "object" && "block" in reply && reply.block)).toBe(false);
  expect(input.path).toBe(await realpath(join(root, "SKILL.md")));
  expect(pins).toEqual([a]);
  expect(lookups).toBe(1);
});

async function logicalReferenceFixture(options: { use?: boolean; shortRefs?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "broker-logical-uri-"));
  await writeFile(join(root, "SKILL.md"), record.body);
  await mkdir(join(root, "references"));
  await writeFile(join(root, "references/guide.md"), "Fixed historical resource.");
  const owner: SkillRecord = { ...record, name: "URI Example", alias: "uri-example", normalizedName: "uri-example",
    id: "shared_skill:lib:skill", ref: "skill://shared_skill%3Alib%3Askill/SKILL.md", entrypoint: "SKILL.md",
    token: "notion/uri-example", path: join(root, "SKILL.md"), metadataIndexPath: undefined, defaultDiscovery: false,
    ...(options.shortRefs ? { sourceScope: "a".repeat(64), enabled: true, default_context: false,
      locator: { type: "shared_skill" as const, library_id: "lib", skill_id: "skill", page_id: "00000000-0000-4000-8000-000000000001",
        database_id: "00000000-0000-4000-8000-000000000002", data_source_id: "00000000-0000-4000-8000-000000000003" } } : {}) };
  const controller = new AbortController(), events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const tools: Parameters<NonNullable<ExtensionAPI["registerTool"]>>[0][] = [];
  const entries: SessionEntry[] = [];
  const api: ExtensionAPI = { on(name, listener) { events.set(name, [...events.get(name) ?? [], listener]); }, registerTool(tool) { tools.push(tool); },
    ...(options.shortRefs ? { appendEntry(customType: string, data?: unknown) { entries.push({ type: "custom", customType, data }); } } : {}) };
  const ctx: ExtensionContext = { cwd: root, hasUI: false, mode: "rpc", signal: controller.signal,
    ...(options.shortRefs ? { sessionManager: { getBranch: () => entries, getSessionId: () => "logical-session", getSessionFile: () => join(root, "session.jsonl") } } : {}) };
  const state = { calls: [] as string[], loads: [] as Array<string | undefined>, refreshes: [] as Array<boolean | undefined>, graphRoots: [] as Array<Array<string | undefined>>,
    resolve: async (value: string, _signal?: AbortSignal) => {
      const ref = parseNativeReference(value);
      if (![owner.name, owner.alias].includes(ref.selector)) throw Object.assign(new Error("Not found"), { code: "SKILL_NOT_FOUND" });
      return { record: { ...owner, body: undefined }, ref: "skill://shared_skill%3Alib%3Askill/" + (ref.path || owner.entrypoint)
        + (ref.snapshot ? "?snapshot=" + ref.snapshot : "") };
    } };
  const host = await installHostSkills(api, {
    config: { sources: [{ type: "notion", id: "notion", prefetch: false }] },
    getRecords: async () => ({ records: [{ ...owner, body: undefined, snapshotId: undefined }], failures: [] }),
    resolveNamedReference: async (value: string, _ctx: ExtensionContext, signal?: AbortSignal, refresh?: boolean) => {
      state.calls.push(value); state.refreshes.push(refresh); return state.resolve(value, signal);
    },
    loadRecord: async (_record, _signal, pin) => { state.loads.push(pin); return owner; },
    ...(options.use ? { prepareGraph: async (records: readonly SkillRecord[]) => {
      state.graphRoots.push(records.map(record => record.ref));
      throw Object.assign(new Error("Controlled exact preparation boundary"), { code: "CONTROLLED_PREPARATION" });
    } } : {}),
  }, createPiHostAdapter(api));
  async function read(path: string) {
    const input = { path }, values: unknown[] = [];
    for (const listener of events.get("tool_call") ?? []) values.push(await listener({ toolName: "read", toolCallId: "logical", input } as never, ctx));
    return { input, values };
  }
  const emit = async (name: string) => { for (const listener of events.get(name) ?? []) await listener({ type: name } as never, ctx); };
  return { root, owner, ctx, controller, state, host, read, emit, entries,
    use: async (input: Record<string, unknown>) => {
      const tool = tools.find(tool => tool.name === "notion_use");
      if (!tool) throw new Error("Expected the actual registered Notion use tool");
      return tool.execute("name-use", input, controller.signal, undefined, ctx);
    } };
}

test("SC25 use resolves names into exact canonical roots and applies refresh to name discovery", async () => {
  const f = await logicalReferenceFixture({ use: true });
  try {
    const names = ["skill://URI%20Example/SKILL.md", "skill://uri-example/SKILL.md"];
    await expect(f.use({ ref: names })).rejects.toMatchObject({ code: "CONTROLLED_PREPARATION" });
    expect(f.state.graphRoots).toEqual([[f.owner.ref, f.owner.ref]]); expect(f.state.calls).toEqual(names);
    await expect(f.use({ ref: names[0], refresh: true })).rejects.toMatchObject({ code: "CONTROLLED_PREPARATION" });
    expect(f.state.refreshes.at(-1)).toBe(true);
    const calls = f.state.calls.length;
    await expect(f.use({ ref: "skill://URI%20Example/SKILL.md?snapshot=" + a, refresh: true })).rejects.toMatchObject({ code: "PREPARE_VERSION_CONFLICT" });
    expect(f.state.calls).toHaveLength(calls); expect(f.state.graphRoots).toHaveLength(2);
    await expect(f.use({ ref: f.owner.ref })).rejects.toMatchObject({ code: "CONTROLLED_PREPARATION" });
    expect(f.state.calls).toHaveLength(calls);
  } finally { await f.emit("session_shutdown"); }
});

test.each(["URI Example", "uri-example"])("SC25 logical URI %s uses authoritative resolution and retains the canonical fast path", async selector => {
  const f = await logicalReferenceFixture();
  try {
    const canonical = await f.read(f.owner.ref!);
    expect(canonical.input.path).toBe(await realpath(f.owner.path));
    expect(f.state.calls).toEqual([]);
    const ref = "skill://" + encodeURIComponent(selector) + "/SKILL.md", logical = await f.read(ref);
    expect(logical.values.filter(value => value && typeof value === "object" && "block" in value && value.block)).toEqual([]);
    expect(logical.input.path).toBe(await realpath(f.owner.path));
    expect(f.state.calls).toEqual([ref]);
  } finally { await f.emit("session_shutdown"); }
});

test("SC25 fixed historical name retains the requested owner and snapshot", async () => {
  const f = await logicalReferenceFixture(), ref = "skill://Old%20Name/references/guide.md?snapshot=" + a;
  try {
    f.state.resolve = async value => {
      expect(value).toBe(ref);
      return { record: { ...f.owner, name: "Old Name", alias: "old-name", body: undefined },
        ref: "skill://shared_skill%3Alib%3Askill/references/guide.md?snapshot=" + a };
    };
    const result = await f.read(ref);
    expect(result.values.filter(value => value && typeof value === "object" && "block" in value && value.block)).toEqual([]);
    expect(result.input.path).toBe(await realpath(join(f.root, "references/guide.md")));
    expect(f.state.calls).toEqual([ref]); expect(f.state.loads).toEqual([a]);
  } finally { await f.emit("session_shutdown"); }
});

test("SC25 name failures cannot fall back to the projected directory or weaken fixed URI checks", async () => {
  const f = await logicalReferenceFixture();
  try {
    for (const code of ["CATALOG_INCOMPLETE", "SKILL_AMBIGUOUS", "CONTENT_DISABLED", "SNAPSHOT_CONFLICT"]) {
      f.state.resolve = async () => { throw Object.assign(new Error(code), { code }); };
      expect(JSON.stringify((await f.read("skill://URI%20Example/SKILL.md")).values)).toContain(code);
    }
    expect(f.state.loads).toEqual([]);
    const calls = f.state.calls.length;
    expect(JSON.stringify((await f.read("skill://URI%20Example/guide.md?snapshot=" + a + "&file_id=guide")).values)).toContain("SOURCE_REFERENCE_INVALID");
    expect(f.state.calls).toHaveLength(calls);
    expect((await f.read(f.owner.ref!)).input.path).toBe(await realpath(f.owner.path));
    expect(f.state.calls).toHaveLength(calls);
  } finally { await f.emit("session_shutdown"); }
});

test.each(["abort", "session_switch"])("SC25 name resolution cannot publish after %s", async boundary => {
  const f = await logicalReferenceFixture(), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  const resolve = f.state.resolve;
  try {
    f.state.resolve = async (value, signal) => { entered.resolve(); await released.promise; return resolve(value, signal); };
    const pending = f.read("skill://URI%20Example/SKILL.md");
    const didEnter = await Promise.race([entered.promise.then(() => true), pending.then(() => false)]);
    expect(didEnter).toBe(true);
    if (boundary === "abort") f.controller.abort(); else await f.emit("session_switch");
    released.resolve();
    const result = await pending;
    expect(JSON.stringify(result.values)).toContain("CANCELLED");
    expect(result.input.path).toBe("skill://URI%20Example/SKILL.md");
    expect(f.state.loads).toEqual([]);
  } finally { released.resolve(); await f.emit("session_shutdown"); }
});

function ambiguityCandidates(owner: SkillRecord) {
  const first = { ...owner, body: undefined, snapshotId: undefined };
  const second: SkillRecord = { ...first, sourceId: "other", sourceScope: "b".repeat(64) };
  return [{ record: first, ref: first.ref! }, { record: second, ref: second.ref! }];
}

test.each([
  ["read", "abort"], ["read", "session_switch"], ["notion_use", "abort"], ["notion_use", "session_switch"],
] as const)("SC04 a %s ambiguity arriving after %s cannot publish candidate handles", async (tool, boundary) => {
  const f = await logicalReferenceFixture({ shortRefs: true, use: tool === "notion_use" }), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  try {
    f.state.resolve = async () => { entered.resolve(); await released.promise; throw new SourceReferenceAmbiguity("notion", ambiguityCandidates(f.owner)); };
    const pending = (tool === "read" ? f.read("skill://URI%20Example/SKILL.md") : f.use({ ref: "skill://URI%20Example/SKILL.md" }))
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    await entered.promise;
    if (boundary === "abort") f.controller.abort(); else await f.emit("session_switch");
    released.resolve();
    const result = await pending;
    if (tool === "notion_use") {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Cancelled use must reject");
      expect(result.error).toMatchObject({ code: "SOURCE_ACTIVATION_CANCELLED" });
      expect(String(result.error)).not.toContain("candidates");
    } else {
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(JSON.stringify(result.value)).toContain("SOURCE_ACTIVATION_CANCELLED");
      expect(JSON.stringify(result.value)).not.toContain("candidates");
    }
    expect(f.entries).toEqual([]); expect(f.state.loads).toEqual([]); expect(f.state.graphRoots).toEqual([]);
  } finally { released.resolve(); await f.emit("session_shutdown"); }
});

test("SC04 candidate errors expose only safe metadata and reject mismatched fixed owners before binding", async () => {
  const f = await logicalReferenceFixture({ shortRefs: true, use: true });
  try {
    const candidates = ambiguityCandidates(f.owner);
    candidates[0]!.record.body = "PRIVATE_BODY"; candidates[0]!.record.path = "/private/machine-path";
    f.state.resolve = async () => { throw new SourceReferenceAmbiguity("notion", candidates); };
    let error: unknown; try { await f.use({ ref: "skill://URI%20Example/SKILL.md" }); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(SourceReferenceAmbiguity);
    if (!(error instanceof SourceReferenceAmbiguity)) throw new Error("Expected the actual registered ambiguity error");
    const output = JSON.parse(error.message);
    expect(output.candidates.map((value: Record<string, unknown>) => Object.keys(value).sort())).toEqual([
      ["name", "ref", "selectable", "source"], ["name", "ref", "selectable", "source"],
    ]);
    for (const privateValue of ["PRIVATE_BODY", "/private/machine-path", "sourceScope", "locator", "versionId"]) {
      expect(error.message).not.toContain(privateValue);
      expect(JSON.stringify(error)).not.toContain(privateValue);
    }
    const persisted = f.entries.length;
    f.state.resolve = async () => { throw new SourceReferenceAmbiguity("notion", candidates); };
    expect(JSON.stringify((await f.read("skill://URI%20Example/SKILL.md?snapshot=" + a)).values)).toContain("SOURCE_IDENTITY_MISMATCH");
    expect(f.entries).toHaveLength(persisted); expect(f.state.loads).toEqual([]); expect(f.state.graphRoots).toEqual([]);
    f.state.resolve = async () => { throw Object.assign(new SourceError("SKILL_AMBIGUOUS", "notion"), { details: { token: "PRIVATE_TOKEN", candidates } }); };
    const ordinary = JSON.stringify((await f.read("skill://URI%20Example/SKILL.md")).values);
    expect(ordinary).toContain("SKILL_AMBIGUOUS");
    expect(ordinary).not.toContain("PRIVATE_TOKEN"); expect(ordinary).not.toContain('"candidates"');
    expect(f.entries).toHaveLength(persisted);
  } finally { await f.emit("session_shutdown"); }
});
