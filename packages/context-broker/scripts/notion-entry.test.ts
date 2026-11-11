import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { publishNotionEntry, materializeNotionEntryFile, materializeNotionResourceBatch } from "../src/notion-entry";
import { installHostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { hasLoadedSkill } from "../src/index";
import { sessionSourceSnapshot, sourceMessageText } from "../src/session-source-snapshot";
import { parseNativeReference } from "../src/native-reference";
import type { AgentMessage, ContentRecord, ExtensionAPI, ExtensionContext, SkillRecord } from "../src/types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ensure = async (path: string) => { await mkdir(path, { recursive: true }); };

test("binary batch projection materializes only selected bytes and reuses fixed verified paths without a main entry", async () => {
  const f = await entry(), bytes = Buffer.from([0, 255, 1, 254, 2, 253, 3]);
  const resource = { requested_ref: f.files[1]!.ref, ref: f.files[1]!.ref, path: "assets/data.bin", file_id: "binary",
    bytes: bytes.length, sha256: hash(bytes), encoding: "base64" as const, content: bytes.toString("base64") };
  const metadata = { ...f.metadata, snapshotId: f.selected.snapshotId }, cache = join(f.root, "resources-only");
  const result = await materializeNotionResourceBatch(metadata, [resource], cache, ensure);
  expect(result[0]?.encoding).toBe("base64");
  const output = result[0]!.encoding === "base64" ? result[0]!.output : "";
  expect(await readFile(output)).toEqual(bytes);
  expect(await stat(join(dirname(output), "SKILL.md")).then(() => true, () => false)).toBe(false);
  expect(metadata.body).toBeUndefined(); expect(metadata.entryManifest).toBeUndefined();
  const files = await readdir(dirname(output));
  expect(await materializeNotionResourceBatch(metadata, [resource], cache, ensure)).toEqual(result);
  expect(await readdir(dirname(output))).toEqual(files);
  await writeFile(output, "corrupt");
  await expect(materializeNotionResourceBatch(metadata, [resource], cache, ensure)).rejects.toMatchObject({ code: "SOURCE_OUTPUT_CONFLICT" });
});

test("binary batch rejects invalid bytes, traversal, symlinks and cancellation without a ready result", async () => {
  const f = await entry(), bytes = Buffer.from([0, 255]);
  const record = { ...f.metadata, snapshotId: f.selected.snapshotId }, cache = join(f.root, "resource-errors");
  const file = { requested_ref: f.files[1]!.ref, ref: f.files[1]!.ref, path: "data.bin", bytes: bytes.length, sha256: hash(bytes), encoding: "base64" as const, content: bytes.toString("base64") };
  await expect(materializeNotionResourceBatch(record, [{ ...file, content: "corrupt" }], cache, ensure)).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
  await expect(materializeNotionResourceBatch(record, [{ ...file, path: "../outside" }], cache, ensure)).rejects.toMatchObject({ code: "SOURCE_REFERENCE_INVALID" });
  const destination = join(cache, "scopes", record.sourceScope!, "records", hash(record.id!), "resources", record.snapshotId!, "tree", file.path);
  await symlink(f.selected.path, destination);
  await expect(materializeNotionResourceBatch(record, [file], cache, ensure)).rejects.toMatchObject({ code: "SOURCE_CACHE_UNSAFE" });
  const signal = new AbortController(); signal.abort();
  await expect(materializeNotionResourceBatch(record, [file], cache, ensure, signal.signal)).rejects.toMatchObject({ code: "SOURCE_CANCELLED" });
});
async function entry(nested = false, resourceHasFileId = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "broker-entry-boundary-")));
  const id = "shared_skill:entry-test:owner", snapshot = "s_" + hash("entry snapshot"), scope = hash("entry scope");
  const main = nested ? "instructions/SKILL.md" : "SKILL.md", resource = "references/guide.md";
  const ref = "skill://" + encodeURIComponent(id) + "/";
  const content: ContentRecord = {
    id, kind: "skill", name: "owner", alias: "owner", description: "Entry boundary", default_context: false, enabled: true,
    entrypoint: main, ref: ref + main,
    locator: { type: "shared_skill", library_id: "entry-test", skill_id: "owner", page_id: "00000000-0000-4000-8000-000000000001",
      database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" },
  };
  const bytes = new Map([[main, Buffer.from("---\nname: owner\n---\nExact main instructions.\n")], [resource, Buffer.from("Exact resource bytes.\n")]]);
  const files = [...bytes].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes),
    ref: ref + path + "?snapshot=" + snapshot + (path === main ? "&file_id=main" : resourceHasFileId ? "&file_id=guide" : "") }));
  const metadata: SkillRecord = { ...content, sourceId: "notion", source: "notion", sourceScope: scope,
    path: join(root, "metadata", "SKILL.md"), aliases: [], normalizedAliases: [], normalizedName: "owner", normalizedDescription: "Entry boundary", autoloadEnabled: false };
  const selected: SkillRecord = { ...metadata, body: bytes.get(main)!.toString("utf8"), snapshotId: snapshot, versionId: hash("version"),
    preparationBinding: { record: content, scope, snapshot_id: snapshot, version_id: hash("version"), body_sha256: hash(bytes.get(main)!), ref: files[0]!.ref },
    fileBindings: [
      { path: main, file_id: "main", page_id: content.locator.type === "shared_skill" ? content.locator.page_id : "" },
      ...(resourceHasFileId ? [{ path: resource, file_id: "guide", page_id: "00000000-0000-4000-8000-000000000002" }] : []),
    ],
  };
  const published = await publishNotionEntry(selected, files, join(root, "cache"), ensure);
  return { root, main, resource, metadata, selected: published, bytes, files };
}

test("corrupt and interrupted resource outputs never become ready, and a new owner can retry the exact file", async () => {
  const f = await entry();
  const fetch = async (file: { path: string }, output: string) => { await writeFile(output, f.bytes.get(file.path)!); };
  const destination = join(f.selected.entryManifest!.root, f.resource);
  await expect(materializeNotionEntryFile(f.selected, f.resource, ensure, async (_file, output) => { await writeFile(output, "corrupt"); }))
    .rejects.toMatchObject({ code: "SOURCE_OUTPUT_CONFLICT" });
  expect(await stat(destination).then(() => true, () => false)).toBe(false);
  const cancelled = new AbortController();
  await expect(materializeNotionEntryFile(f.selected, f.resource, ensure, async (file, output) => {
    await fetch(file, output); cancelled.abort();
  }, cancelled.signal)).rejects.toMatchObject({ code: "SOURCE_CANCELLED" });
  expect(await stat(destination).then(() => true, () => false)).toBe(false);
  expect(f.selected.entryManifest?.materialized_paths).toEqual([f.main]);
  const completed = await materializeNotionEntryFile(f.selected, f.resource, ensure, fetch);
  expect(await readFile(completed)).toEqual(f.bytes.get(f.resource)!);
  expect(f.selected.entryManifest?.local_files_ready).toBe(true);
  const restarted = await publishNotionEntry(f.selected, f.files, join(f.root, "cache"), ensure);
  expect(restarted.entryManifest?.materialized_paths).toEqual([f.main]);
  expect(restarted.entryManifest?.local_files_ready).toBe(false);
});

test("a conflicting entry manifest or foreign File ID cannot replace an immutable ready entry", async () => {
  const f = await entry();
  await expect(publishNotionEntry(f.selected, f.files.map(file => file.path === f.resource ? { ...file, sha256: hash("different") } : file), join(f.root, "cache"), ensure))
    .rejects.toMatchObject({ code: "SOURCE_OUTPUT_CONFLICT" });
  await expect(publishNotionEntry(f.selected, f.files.map(file => file.path === f.resource ? { ...file, ref: file.ref.replace("file_id=guide", "file_id=foreign") } : file), join(f.root, "cache"), ensure))
    .rejects.toMatchObject({ code: "SHARED_FILE_BINDING_UNAVAILABLE" });
  expect(await readFile(f.selected.path)).toEqual(f.bytes.get(f.main)!);
  expect(f.selected.entryManifest?.local_files_ready).toBe(false);
});

test("native resource tools resolve stable File ID and report materialization without claiming main delivery", async () => {
  const f = await entry();
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const api = { on(name: string, listener: (event: never, ctx: ExtensionContext) => unknown) { events.set(name, [...events.get(name) ?? [], listener]); } } as ExtensionAPI;
  const ctx: ExtensionContext = { cwd: f.root, hasUI: false, mode: "rpc" };
  const requested: string[] = [];
  await installHostSkills(api, { config: {}, getRecords: async () => ({ records: [f.metadata], failures: [] }),
    loadRecord: async () => f.selected,
    loadResource: async (record, path, _ctx, signal) => {
      requested.push(path);
      return materializeNotionEntryFile(record, path, ensure, async (file, output) => { await writeFile(output, f.bytes.get(file.path)!); }, signal);
    },
  }, createPiHostAdapter(api));
  const emit = async (name: string, event: unknown) => { const result = []; for (const listener of events.get(name) ?? []) result.push(await listener(event as never, ctx)); return result; };
  const input = { path: f.files[1]!.ref.replace(f.resource, "old-spelling.md") };
  const admission = await emit("tool_call", { toolName: "read", toolCallId: "resource", input });
  expect(admission, JSON.stringify(admission)).not.toContainEqual(expect.objectContaining({ block: true }));
  expect(input.path).toBe(join(f.selected.entryManifest!.root, f.resource));
  expect(requested).toEqual([f.resource]);
  const content = [{ type: "text" as const, text: f.bytes.get(f.resource)!.toString("utf8") }];
  const returned = await emit("tool_result", { toolName: "read", toolCallId: "resource", input, content, isError: false, details: { original: true } });
  const result = returned.find((value): value is { details: Record<string, unknown> } => !!value && typeof value === "object" && "details" in value)!;
  expect(result.details.original).toBe(true);
  expect(result.details.contextBrokerRead).toBeUndefined();
  expect(result.details.contextBrokerResource).toMatchObject({
    version: 1, id: f.selected.id, scope: f.selected.sourceScope, snapshot_id: f.selected.snapshotId,
    file_id: "guide", path: f.resource, ref: f.files[1]!.ref, bytes: f.files[1]!.bytes, sha256: f.files[1]!.sha256,
    delivered_complete_text: true, loaded: false,
  });
  const history: AgentMessage[] = [{ role: "toolResult", toolName: "read", toolCallId: "resource", isError: false, content, details: result.details }];
  expect(hasLoadedSkill(history, f.selected)).toBe(false);
  await emit("tool_call", { toolName: "read", toolCallId: "partial", input: { path: f.files[1]!.ref } });
  const partial = await emit("tool_result", { toolName: "read", toolCallId: "partial", content: [{ type: "text", text: "Exact" }], isError: false });
  expect(JSON.stringify(partial)).toContain('"delivered_complete_text":false');
  await emit("tool_call", { toolName: "read", toolCallId: "old", input: { path: f.files[1]!.ref } });
  await emit("session_switch", { type: "session_switch" });
  expect(await emit("tool_result", { toolName: "read", toolCallId: "old", content, isError: false })).toEqual([undefined]);
});

for (const resourceHasFileId of [true, false]) for (const scheduling of ["sequential", "concurrent"] as const) test(`${resourceHasFileId ? "File ID" : "owner path"} ${scheduling} resource reads through an exact ref and advertised tree path deliver one provider body`, async () => {
  const f = await entry(false, resourceHasFileId);
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const api = { on(name: string, listener: (event: never, ctx: ExtensionContext) => unknown) { events.set(name, [...events.get(name) ?? [], listener]); } } as ExtensionAPI;
  const ctx: ExtensionContext = { cwd: f.root, hasUI: false, mode: "rpc" }, requested: string[] = [];
  let release!: () => void;
  const bothEntered = new Promise<void>(resolve => { release = resolve; });
  const host = await installHostSkills(api, { config: {}, getRecords: async () => ({ records: [f.metadata], failures: [] }),
    loadRecord: async () => f.selected,
    loadResource: async (record, path, _ctx, signal) => {
      requested.push(path);
      if (scheduling === "concurrent") {
        if (requested.length === 2) release();
        await bothEntered;
      }
      return materializeNotionEntryFile(record, path, ensure, async (file, output) => { await writeFile(output, f.bytes.get(file.path)!); }, signal);
    },
  }, createPiHostAdapter(api));
  await host.activate(f.metadata, ctx);
  const emit = async (name: string, event: unknown) => { const values = []; for (const listener of events.get(name) ?? []) values.push(await listener(event as never, ctx)); return values; };
  const read = async (path: string, toolCallId: string): Promise<AgentMessage> => {
    const input = { path };
    const admission = await emit("tool_call", { toolName: "read", toolCallId, input });
    expect(admission.some(value => value && typeof value === "object" && "block" in value)).toBe(false);
    const content = [{ type: "text" as const, text: await readFile(input.path, "utf8") }];
    const returned = await emit("tool_result", { toolName: "read", toolCallId, input, content, isError: false });
    const annotated = returned.find((value): value is { details: unknown } => !!value && typeof value === "object" && "details" in value)!;
    expect(annotated).toBeDefined();
    return { role: "toolResult", toolName: "read", toolCallId, isError: false, content, details: annotated.details };
  };
  const reference = f.files[1]!.ref, advertisedPath = join(f.selected.entryManifest!.root, f.resource);
  const history = scheduling === "concurrent"
    ? await Promise.all([read(reference, "resource-ref"), read(advertisedPath, "resource-path")])
    : [await read(reference, "resource-ref"), await read(advertisedPath, "resource-path")];
  for (const message of history) {
    const proof = (message.details as { contextBrokerResource: Record<string, unknown> }).contextBrokerResource;
    expect(proof).toMatchObject({ ref: reference, path: f.resource, delivered_complete_text: true, loaded: false });
    expect(proof.file_id).toBe(resourceHasFileId ? "guide" : undefined);
    expect(parseNativeReference(String(proof.ref)).fileId).toBe(resourceHasFileId ? "guide" : undefined);
    expect(Object.hasOwn(JSON.parse(JSON.stringify(proof)), "file_id")).toBe(resourceHasFileId);
  }
  const stored = JSON.stringify(history);
  const context = (await emit("context", { messages: history })).find((value): value is { messages: AgentMessage[] } => !!value && typeof value === "object" && "messages" in value)!;
  expect(requested).toEqual([f.resource, f.resource]);
  expect(context.messages.filter(message => sourceMessageText(message.content) === f.bytes.get(f.resource)!.toString("utf8"))).toHaveLength(1);
  expect(context.messages.map(message => message.toolCallId)).toEqual(["resource-ref", "resource-path"]);
  expect(JSON.stringify(history)).toBe(stored);
  expect(hasLoadedSkill(context.messages, f.selected)).toBe(false);
  expect(sessionSourceSnapshot(context.messages, f.selected)).toBeUndefined();
});

test("a nested main can read a sibling-directory resource from its exact immutable tree path", async () => {
  const f = await entry(true);
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const api = { on(name: string, listener: (event: never, ctx: ExtensionContext) => unknown) { events.set(name, [...events.get(name) ?? [], listener]); } } as ExtensionAPI;
  const ctx: ExtensionContext = { cwd: f.root, hasUI: false, mode: "rpc" }, requested: string[] = [];
  const host = await installHostSkills(api, { config: {}, getRecords: async () => ({ records: [f.metadata], failures: [] }),
    loadRecord: async () => f.selected,
    loadResource: async (record, path, _ctx, signal) => {
      requested.push(path);
      return materializeNotionEntryFile(record, path, ensure, async (file, output) => { await writeFile(output, f.bytes.get(file.path)!); }, signal);
    },
  }, createPiHostAdapter(api));
  await host.activate(f.metadata, ctx);
  const input = { path: join(dirname(f.selected.path), "..", f.resource) };
  for (const listener of events.get("tool_call") ?? []) await listener({ toolName: "read", toolCallId: "sibling", input } as never, ctx);
  expect(requested).toEqual([f.resource]);
  expect(await readFile(input.path)).toEqual(f.bytes.get(f.resource)!);
});

async function aliasedEntryHost() {
  const f = await entry();
  const alias = join(f.root, "os-alias");
  await symlink(f.root, alias, "dir");
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const api = { on(name: string, listener: (event: never, ctx: ExtensionContext) => unknown) { events.set(name, [...events.get(name) ?? [], listener]); } } as ExtensionAPI;
  const ctx: ExtensionContext = { cwd: f.root, hasUI: false, mode: "rpc" }, requested: string[] = [];
  const host = await installHostSkills(api, { config: {}, getRecords: async () => ({ records: [f.metadata], failures: [] }),
    loadRecord: async () => f.selected,
    loadResource: async (record, path, _ctx, signal) => {
      requested.push(path);
      return materializeNotionEntryFile(record, path, ensure, async (file, output) => { await writeFile(output, f.bytes.get(file.path)!); }, signal);
    },
  }, createPiHostAdapter(api));
  await host.activate(f.metadata, ctx);
  const aliasedRoot = join(alias, relative(f.root, f.selected.entryManifest!.root));
  return { ...f, aliasedRoot, requested, async read(path: string) {
    const input = { path }, results = [];
    for (const listener of events.get("tool_call") ?? []) results.push(await listener({ toolName: "read", toolCallId: "aliased", input } as never, ctx));
    return { input, results };
  } };
}

test("an outer filesystem alias resolves an unmaterialized declared resource and preserves read suffixes", async () => {
  const f = await aliasedEntryHost();
  const destination = join(f.selected.entryManifest!.root, f.resource);
  expect(await stat(destination).then(() => true, () => false)).toBe(false);
  const first = await f.read(join(f.aliasedRoot, f.resource));
  expect(first.input.path).toBe(destination);
  expect(f.requested).toEqual([f.resource]);
  expect(await readFile(first.input.path)).toEqual(f.bytes.get(f.resource)!);
  const ranged = await f.read(join(f.aliasedRoot, f.resource) + "?snapshot=" + f.selected.snapshotId + ":2");
  expect(ranged.input.path).toBe(destination + ":2");
});

test("an outer alias cannot authorize an undeclared file or a path escaping the immutable tree", async () => {
  const f = await aliasedEntryHost();
  for (const path of [f.aliasedRoot + "/not-in-manifest.md", f.aliasedRoot + "/../outside.md"]) {
    const result = await f.read(path);
    expect(JSON.stringify(result.results)).toContain("FILE_NOT_FOUND");
  }
  expect(f.requested).toEqual([]);
});

test("an outer alias never hides a symlink below the verified entry root", async () => {
  const f = await aliasedEntryHost();
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "guide.md"), f.bytes.get(f.resource)!);
  await symlink(outside, join(f.selected.entryManifest!.root, "references"), "dir");
  const result = await f.read(join(f.aliasedRoot, f.resource));
  expect(JSON.stringify(result.results)).toContain("SOURCE_CACHE_UNSAFE");
  expect(f.requested).toEqual([]);
  expect(await readFile(join(outside, "guide.md"))).toEqual(f.bytes.get(f.resource)!);
});
