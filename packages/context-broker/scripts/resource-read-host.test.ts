import { expect, test } from "bun:test";
import { JsonSchema, Schema, SchemaRepresentation } from "effect";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { createSessionShortRefHost } from "../src/session-short-ref-host";
import { parseNativeReference } from "../src/native-reference";
import { sessionSourceSnapshot } from "../src/session-source-snapshot";
import { DEFAULT_RESOURCE_READ_BUDGET, type ResourceReadBatch, type ResourceReadFile } from "../src/resource-read-types";
import { consumptionEffects, noConsumptionWrites, type ConsumptionEffects } from "../src/consumption-effects";
import { validateResourceReadProjection } from "../src/resource-read-projection";
import { sourceMessageText } from "../src/session-source-snapshot";
import type { ContentRecord, ExtensionAPI, ExtensionContext, PiReadDefinition, SessionEntry, SkillRecord } from "../src/types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "broker-resource-host-"));
  const id = "shared_skill:batch:owner", scope = hash("scope"), snapshot = "s_" + hash("snapshot"), version = hash("version");
  const base = "skill://" + encodeURIComponent(id) + "/", ref = (path: string, file?: string) => base + path + "?snapshot=" + snapshot + (file ? "&file_id=" + file : "");
  const content: ContentRecord = { id, kind: "skill", name: "Owner", alias: "owner", description: "Resource owner metadata", default_context: false, enabled: true,
    entrypoint: "SKILL.md", ref: base + "SKILL.md", locator: { type: "shared_skill", library_id: "batch", skill_id: "owner",
      page_id: "00000000-0000-4000-8000-000000000001", database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" } };
  const metadata: SkillRecord = { ...content, source: "notion", sourceId: "notion", sourceScope: scope, path: join(root, "metadata/SKILL.md"),
    aliases: [], normalizedAliases: [], normalizedName: "owner", normalizedDescription: content.description, autoloadEnabled: false, defaultDiscovery: false };
  await mkdir(join(root, "metadata")); await writeFile(metadata.path, "Owner metadata only");
  const binary = Buffer.from([0, 255, 1, 254, 2, 253, 3]), output = join(root, "selected.bin"); await writeFile(output, binary);
  const files: ResourceReadFile[] = [
    { requested_ref: ref("references/a.md", "a"), ref: ref("references/a.md", "a"), path: "references/a.md", file_id: "a", encoding: "utf8", content: "\ufeffUTF8 雪\r\n", bytes: Buffer.byteLength("\ufeffUTF8 雪\r\n"), sha256: hash("\ufeffUTF8 雪\r\n") },
    { requested_ref: ref("references/b.md", "b"), ref: ref("references/b.md", "b"), path: "references/b.md", file_id: "b", encoding: "utf8", content: "", bytes: 0, sha256: hash("") },
    { requested_ref: ref("assets/selected.bin", "binary"), ref: ref("assets/selected.bin", "binary"), path: "assets/selected.bin", file_id: "binary", encoding: "base64", content: binary.toString("base64"), bytes: binary.length, sha256: hash(binary), output },
  ];
  const scalarOutput = join(root, "selected-text.md"); await writeFile(scalarOutput, files[0]!.content);
  const ownerBinding = { record: content, scope, snapshot_id: snapshot, version_id: version, body_sha256: hash("unread main"), ref: ref("SKILL.md", "main") };
  const manifestFiles = [{ path: "SKILL.md", bytes: 11, sha256: ownerBinding.body_sha256, ref: ownerBinding.ref }, ...files];
  const manifest = { complete: true, scope, snapshot_id: snapshot, version_id: version, record: content, entrypoint: "SKILL.md", files: manifestFiles.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  const state = { id: "session-one", entries: [] as SessionEntry[], calls: [] as string[][], mainReads: 0, persisted: 0,
    nameCalls: [] as string[], fixedCalls: [] as string[], scalarReads: 0, readOnly: [] as Array<boolean | undefined>,
    effects: undefined as ConsumptionEffects | undefined, failure: undefined as Error | undefined,
    transform: (batch: ResourceReadBatch): ResourceReadBatch => batch, wait: undefined as undefined | (() => Promise<void>), signal: undefined as AbortSignal | undefined };
  const events = new Map<string, Array<(event: never, context: ExtensionContext) => unknown>>();
  const tools = new Map<string, { definition: PiReadDefinition; source: string }>();
  const native: PiReadDefinition = { name: "read", label: "read", description: "Native scalar reader", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, outputSchema: { type: "string" },
    async execute(_id, input) {
      state.scalarReads++;
      if (input.path !== scalarOutput) throw new Error("Only the selected fixed resource can enter the scalar reader");
      return { content: [{ type: "text", text: await readFile(scalarOutput, "utf8") }] };
    } };
  tools.set("read", { definition: native, source: "builtin" });
  const api: ExtensionAPI = {
    on(name, handler) { events.set(name, [...events.get(name) ?? [], handler]); },
    registerTool(tool) { tools.set(tool.name, { definition: tool as PiReadDefinition, source: "local" }); },
    getAllTools: () => [...tools.values()].map(({ definition, source }) => ({ ...definition, sourceInfo: { source, path: "/fixture" } })),
    getActiveTools: () => ["read"], appendEntry(customType, data) { state.entries.push({ type: "custom", customType, data }); },
  };
  const ctx: ExtensionContext = { cwd: root, hasUI: false, mode: "rpc", sessionManager: {
    getSessionId: () => state.id, getSessionFile: () => join(root, state.id + ".jsonl"), getBranch: () => state.entries,
  } };
  const host = await installHostSkills(api, {
    config: { sources: [{ id: "notion", type: "notion", prefetch: false }] }, getRecords: async () => ({ records: [metadata], failures: [] }),
    resolveNamedReference: async input => {
      state.nameCalls.push(input);
      const parsed = parseNativeReference(input);
      if (![content.name, content.alias].includes(parsed.selector) || parsed.snapshot !== snapshot) throw new Error("Unexpected fixed name");
      return { record: metadata, ref: ref(parsed.path) };
    },
    loadRecord: async () => { state.mainReads++; throw new Error("Resource reads cannot load the main entry"); },
    prepareGraph: async () => { state.mainReads++; throw new Error("Resource reads cannot prepare a graph"); },
    persistGraphs: () => { state.persisted++; },
    readFixedResource: async (_record, input) => {
      state.fixedCalls.push(input);
      const selected = files[0]!;
      if (parseNativeReference(input).path !== selected.path) throw new Error("Unexpected scalar resource");
      return { selection: { scope, owner: id, snapshot_id: snapshot, version_id: version }, ownerBinding, entrypoint: content.entrypoint,
        file: { requested_ref: input, ref: selected.ref, path: selected.path, file_id: selected.file_id, bytes: selected.bytes, sha256: selected.sha256, output: scalarOutput } };
    },
    readResources: async (_record, refs, _ctx, signal, policy) => {
      state.calls.push([...refs]); state.signal = signal;
      state.readOnly.push(policy?.readOnly);
      await state.wait?.();
      if (state.effects) policy?.observeEffects?.(state.effects);
      if (state.failure) throw state.failure;
      const seen = new Set<string>();
      const selected = refs.map(requested_ref => {
        const parsed = parseNativeReference(requested_ref);
        if (parsed.fileId === "main" || parsed.fileId === undefined && parsed.path === "SKILL.md") throw Object.assign(new Error("Main excluded"), { code: "RESOURCE_MAIN_NOT_ALLOWED" });
        const file = files.find(file => parsed.fileId === undefined ? file.path === parsed.path : file.file_id === parsed.fileId);
        if (!file) throw new Error("Unexpected fixture resource");
        if (seen.has(file.path)) throw Object.assign(new Error("Duplicate canonical selection"), { code: "RESOURCE_SELECTION_CONFLICT" });
        seen.add(file.path); return { ...file, requested_ref };
      });
      return state.transform({ selection: { scope, owner: id, snapshot_id: snapshot, version_id: version }, ownerBinding, manifest, effects: consumptionEffects(state.effects),
        manifest_sha256: hash(JSON.stringify(manifest)), files: selected, budget: DEFAULT_RESOURCE_READ_BUDGET, machine: { status: "ready", manifest, files: selected } });
    },
  }, createPiHostAdapter(api, async () => () => native));
  const emit = async (name: string) => { for (const handler of events.get(name) ?? []) await handler({ type: name } as never, ctx); };
  await emit("session_start"); await host.refresh(ctx);
  const selected: SkillRecord = { ...metadata, snapshotId: snapshot, versionId: version, preparationBinding: ownerBinding,
    fileBindings: [{ path: "SKILL.md", file_id: "main", page_id: "00000000-0000-4000-8000-000000000001" },
      ...files.map((file, index) => ({ path: file.path, file_id: file.file_id!, page_id: "00000000-0000-4000-8000-" + String(index + 2).padStart(12, "0") }))],
    entryManifest: { version: 1, root: join(root, "unmaterialized-entry"), receipt: join(root, "manifest"), manifest_id: hash("fixture"), files: manifestFiles,
      manifest_complete: true, local_files_ready: false, materialized_paths: [] } };
  const short = createSessionShortRefHost(api);
  return { root, ref, files, metadata, selected, ctx, state, emit, short,
    definition: () => tools.get("read")!.definition,
    result: async (result: Record<string, unknown>) => {
      const updates: unknown[] = [];
      for (const handler of events.get("tool_result") ?? []) updates.push(await handler({ toolName: "read", toolCallId: "batch-call", ...result } as never, ctx));
      return updates;
    },
    read: (input: Record<string, unknown>, signal?: AbortSignal) => tools.get("read")!.definition.execute("batch-call", input, signal, undefined, ctx) };
}

test("one resource batch delivers exact selected text and binary metadata without preparing or selecting the owner body", async () => {
  const f = await fixture(), result = await f.read({ paths: f.files.map(file => file.ref) });
  const model = result.structuredContent as { status: string; files: Array<Record<string, unknown>> };
  expect(model.status).toBe("ready"); expect(model.files[0]).toMatchObject({ kind: "text", content: "\ufeffUTF8 雪\r\n" });
  expect(model.files[1]).toMatchObject({ kind: "text", content: "" });
  expect(model.files[2]).toMatchObject({ kind: "binary", output: f.files[2]!.encoding === "base64" ? f.files[2]!.output : "" });
  expect(JSON.stringify(result.content)).not.toContain(f.files[2]!.content);
  expect(f.state.calls).toHaveLength(1); expect(f.state.mainReads).toBe(0); expect(f.state.persisted).toBe(0);
  expect(f.state.scalarReads).toBe(0); expect(f.state.nameCalls).toHaveLength(0);
  expect(f.metadata.body).toBeUndefined(); expect(f.metadata.entryManifest).toBeUndefined();
  expect(sessionSourceSnapshot([{ role: "toolResult", toolName: "read", toolCallId: "batch-call", ...result }], f.metadata)).toBeUndefined();
  expect(result.details).toMatchObject({ contextBrokerResource: { version: 2, toolCallId: "batch-call", loaded: false }, contextBrokerResourceSource: { source_id: "notion" } });
  expect(result.structuredContent).toHaveProperty("effects.remote_writes", "unknown");
});

test("AH639 strict batch passes one policy and preserves complete issued-resource receipts", async () => {
  const f = await fixture(), paths = f.files.map(file => f.short.resource(f.ctx, f.selected, file.ref));
  const entries = f.state.entries.length, effects = noConsumptionWrites();
  f.state.effects = effects;
  const result = await f.read({ paths, readOnly: true }), text = sourceMessageText(result.content);
  expect(f.state.readOnly).toEqual([true]); expect(f.state.calls).toEqual([f.files.map(file => file.ref)]);
  const proof = validateResourceReadProjection(text, (result.details as { contextBrokerResource: unknown }).contextBrokerResource);
  expect(proof).toBeDefined();
  expect(proof?.files.map(file => file.model_ref)).toEqual(paths);
  expect(proof?.files.map(file => file.sha256)).toEqual(f.files.map(file => file.sha256));
  expect(proof?.files.map(file => file.delivered_complete_text)).toEqual([true, true, false]);
  expect(JSON.parse(text)).toMatchObject({ effects, files: [{ content: f.files[0]!.content }, { content: "" }, { kind: "binary" }] });
  expect(result.details).toHaveProperty("effects", effects);
  expect(f.state.entries).toHaveLength(entries);
  expect(f.state.mainReads).toBe(0); expect(f.state.scalarReads).toBe(0); expect(f.state.persisted).toBe(0);
});

test("ready batch effects satisfy the registered Pi output schema", async () => {
  const f = await fixture(), paths = f.files.map(file => f.short.resource(f.ctx, f.selected, file.ref));
  const registered = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(f.definition().outputSchema);
  const decode = Schema.decodeUnknownSync(SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft2020_12(registered)), { onExcessProperty: "error" });
  const ordinary = await f.read({ paths });
  expect(ordinary.structuredContent).toHaveProperty("effects.remote_writes", "unknown");
  expect(decode(ordinary.structuredContent)).toEqual(ordinary.structuredContent);
  f.state.effects = noConsumptionWrites();
  const strict = await f.read({ paths, readOnly: true });
  expect(strict.structuredContent).toHaveProperty("effects.remote_writes", "none");
  expect(decode(strict.structuredContent)).toEqual(strict.structuredContent);
  expect(decode("native scalar output")).toBe("native scalar output");
  const model = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(strict.structuredContent);
  expect(() => decode({ ...model, effects: { ...noConsumptionWrites(), version: "1" } })).toThrow();
  expect(() => decode({ ...model, unexpected: true })).toThrow();
});

test("strict batch failure retains the producer's zero-write receipt without a body delivery", async () => {
  const f = await fixture(), effects = noConsumptionWrites();
  const original = Object.freeze(Object.assign(new Error("Strict source refused a semantic write"), { code: "NOTION_READ_ONLY", details: { effects } }));
  f.state.failure = original;
  await expect(f.read({ paths: f.files.map(file => file.ref), readOnly: true })).rejects.toMatchObject({
    code: "NOTION_READ_ONLY", details: { effects }, cause: original,
  });
  expect(f.state.readOnly).toEqual([true]); expect(f.state.calls).toHaveLength(1);
  expect(f.state.mainReads).toBe(0); expect(f.state.scalarReads).toBe(0); expect(f.state.persisted).toBe(0);
  expect(original.message).toBe("Strict source refused a semantic write");
});

test("SC25 scalar fixed-name resources deliver the exact file without preparing the main entry", async () => {
  const f = await fixture(), input = `skill://Owner/references/a.md?${f.files[0]!.ref.split("?")[1]!.split("&")[0]}`;
  const result = await f.read({ path: input });
  expect(result.content).toEqual([{ type: "text", text: f.files[0]!.content }]);
  expect(await f.result(result)).toEqual(expect.arrayContaining([expect.objectContaining({ details: expect.objectContaining({
    contextBrokerResource: expect.objectContaining({ delivered_complete_text: true, loaded: false, ref: f.files[0]!.ref }),
  }) })]));
  expect(f.state.nameCalls).toEqual([input]); expect(f.state.fixedCalls).toEqual([f.ref("references/a.md")]);
  expect(f.state.scalarReads).toBe(1); expect(f.state.calls).toHaveLength(0); expect(f.state.mainReads).toBe(0); expect(f.state.persisted).toBe(0);
});

test("SC25 fixed-name resource batches preserve one canonical owner and exclude unfixed names before lookup", async () => {
  const f = await fixture(), snapshot = parseNativeReference(f.files[0]!.ref).snapshot;
  const refs = [`skill://Owner/references/a.md?snapshot=${snapshot}`, `skill://owner/references/b.md?snapshot=${snapshot}`];
  const result = await f.read({ paths: refs });
  expect(result.structuredContent).toHaveProperty("files.0.content", f.files[0]!.content);
  expect(result.structuredContent).toHaveProperty("files.1.content", "");
  expect(f.state.calls).toEqual([[f.ref("references/a.md"), f.ref("references/b.md")]]);
  expect(f.state.nameCalls).toEqual(refs); expect(f.state.mainReads).toBe(0); expect(f.state.scalarReads).toBe(0); expect(f.state.persisted).toBe(0);
  await expect(f.read({ paths: ["skill://Owner/references/a.md"] })).rejects.toMatchObject({ code: "SOURCE_REFERENCE_INVALID" });
  expect(f.state.nameCalls).toEqual(refs); expect(f.state.calls).toHaveLength(1);
});

test("batch admission rejects invalid modes and identities before any SDK operation", async () => {
  const f = await fixture(), first = f.files[0]!.ref;
  const selected = f.short.selected(f.ctx, f.selected);
  for (const input of [
    { paths: [] }, { path: first, paths: [first] }, { paths: [first], offset: 1 }, { paths: ["/local/file"] },
    { paths: [first], readOnly: "true" }, { paths: [first], readOnly: null },
    { paths: [first.split("?")[0]!] }, { paths: [selected] }, { paths: [first, first] },
    { paths: [first, first.replace("references/a.md", "old.md")] },
    { paths: [first, f.files[1]!.ref.replace(/snapshot=s_[a-f0-9]+/, "snapshot=s_" + hash("other"))] },
    { paths: [first, f.files[1]!.ref.replace("shared_skill%3Abatch%3Aowner", "shared_skill%3Abatch%3Aother")] },
    { paths: [f.ref("SKILL.md")] }, { paths: Array.from({ length: 17 }, (_, index) => f.ref("resources/" + index + ".md")) },
  ]) await expect(f.read(input)).rejects.toThrow();
  expect(f.state.calls).toHaveLength(0); expect(f.state.mainReads).toBe(0);
});

test("stable File ID resolves old path hints and canonical aliases are rejected after selection", async () => {
  const f = await fixture();
  const sameHint = await f.read({ paths: [f.ref("old.md", "a"), f.ref("old.md", "b")] });
  expect((sameHint.structuredContent as { files: Array<{ path: string }> }).files.map(file => file.path)).toEqual(["references/a.md", "references/b.md"]);
  expect(await f.read({ paths: [f.ref("SKILL.md", "a")] })).toHaveProperty("structuredContent.files.0.path", "references/a.md");
  expect(await f.read({ paths: [f.ref("references/a.md")] })).toHaveProperty("structuredContent.files.0.ref", f.files[0]!.ref);
  await expect(f.read({ paths: [f.ref("old.md", "a"), f.ref("references/a.md")] })).rejects.toMatchObject({ code: "RESOURCE_SELECTION_CONFLICT" });
  await expect(f.read({ paths: [f.ref("old.md", "main")] })).rejects.toMatchObject({ code: "RESOURCE_MAIN_NOT_ALLOWED" });
  expect(f.state.mainReads).toBe(0);
});

test("short resource refs retain their owner commitment without a main body or new session binding", async () => {
  const f = await fixture(), short = f.short.resource(f.ctx, f.selected, f.files[0]!.ref), entries = f.state.entries.length;
  expect(await f.read({ paths: [short] })).toHaveProperty("structuredContent.files.0.ref", short);
  expect(f.state.entries).toHaveLength(entries); expect(f.state.mainReads).toBe(0);
  f.state.transform = batch => ({ ...batch, ownerBinding: { ...batch.ownerBinding, body_sha256: hash("foreign owner") } });
  await expect(f.read({ paths: [short] })).rejects.toMatchObject({ code: "SHORT_REF_OWNER_MISMATCH" });
});

test("foreign source results and late results after cancellation or session switch cannot deliver a batch", async () => {
  const wrong = await fixture(); wrong.state.transform = batch => ({ ...batch, selection: { ...batch.selection, scope: hash("foreign") } });
  await expect(wrong.read({ paths: [wrong.files[0]!.ref], readOnly: true })).rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
  for (const boundary of ["abort", "session"] as const) {
    const f = await fixture(), waiting = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), controller = new AbortController();
    f.state.wait = () => { entered.resolve(); return waiting.promise; };
    const pending = f.read({ paths: [f.files[0]!.ref] }, controller.signal); await entered.promise;
    if (boundary === "abort") controller.abort(); else { f.state.id = "session-two"; await f.emit("session_switch"); }
    waiting.resolve(); await expect(pending).rejects.toMatchObject({ code: "SOURCE_CANCELLED" });
    expect(f.state.mainReads).toBe(0); expect(f.state.persisted).toBe(0); expect(f.state.signal?.aborted).toBe(true);
  }
});
