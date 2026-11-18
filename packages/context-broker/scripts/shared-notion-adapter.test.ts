import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { currentNotionFixture } from "./fixtures/current-notion-source";
import { normalizeSources } from "../src/sources";
import { sharedSkillId } from "../src/shared-skill-identity";
import { preciseRecordToken, matchesPreciseRecordToken } from "../src/discovery-records";
import type { ContentRecord, ExtensionAPI, ExtensionContext, SkillRecord, SourceConfig } from "../src/types";

type NotionSource = Extract<SourceConfig, { type: "notion" }>;
type Json = Record<string, unknown>;
const uuid = (n: number) => "00000000-0000-4000-8000-" + n.toString().padStart(12, "0");
const database = uuid(10), dataSource = uuid(11), page = uuid(1), scope = "a".repeat(64), snapshot = "s_" + "b".repeat(64);
const exists = (path: string) => stat(path).then(() => true, () => false);
function sharedRecord(): ContentRecord {
  return { id: "shared_skill:current-source:entry", kind: "skill", name: "entry", alias: "entry", description: "Current shared item", default_context: false, enabled: true,
    entrypoint: "SKILL.md", ref: "skill://shared_skill%3Acurrent-source%3Aentry/SKILL.md",
    locator: { type: "shared_skill", library_id: "current-source", skill_id: "entry", page_id: page, database_id: database, data_source_id: dataSource } };
}
function hostRecord(): SkillRecord {
  return { ...sharedRecord(), source: "notion", sourceId: "shared", sourceScope: scope, aliases: [], autoloadEnabled: true,
    path: "/metadata/SKILL.md", normalizedName: "entry", normalizedAliases: [], normalizedDescription: "Current shared item" };
}
function directory(f: Awaited<ReturnType<typeof currentNotionFixture>>) {
  return { ...f.state.catalog, view_selection: "explicit", view: { id: uuid(20), name: "Selected", type: "table", database_id: database,
    data_source_id: dataSource, url: "https://notion.so/selected" }, coverage: { ...f.state.catalog.coverage, method: "explicit_view" } };
}

test("one paired SDK operation produces independent metadata projections without body loading or another cache authority", async () => {
  const f = await currentNotionFixture(); f.state.directory = directory(f);
  const result = await f.boundary.discoverNotionCatalogAndDirectory(f.source, f.root, {});
  expect(result.catalog.ok).toBe(true); expect(result.directory.ok).toBe(true);
  if (!result.catalog.ok || !result.directory.ok) throw Error("Expected both current directories");
  for (const records of [result.catalog.value, result.directory.value]) {
    expect(records).toHaveLength(1); expect(records[0]?.body).toBeUndefined();
    expect(records[0]?.sourceScope).toBe(f.selected.sourceScope);
    expect(await readFile(records[0]!.path, "utf8")).not.toContain(f.body);
  }
  expect(f.calls).toHaveLength(1); expect(f.calls[0]?.operation).toBe("list");
  expect(f.calls[0]?.options.directory).toEqual({});
  expect(Object.hasOwn(f.calls[0]!.options, "readOnly")).toBe(false);
  expect(await exists(join(f.source.cacheDir!, "catalogs-v4"))).toBe(false);
});

test("an empty full catalog cannot authorize a directory from a different credential scope", async () => {
  const f = await currentNotionFixture();
  f.state.directory = { ...directory(f), scope: "f".repeat(64) };
  f.state.catalog = { ...f.state.catalog, records: [], count: 0 };
  const result = await f.boundary.discoverNotionCatalogAndDirectory(f.source, f.root, {});
  expect(result.catalog.ok).toBe(true);
  if (!result.catalog.ok) throw Error("Expected a successful empty catalog");
  expect(result.catalog.value).toHaveLength(0);
  expect(result.directory).toEqual({ ok: false, code: "SOURCE_IDENTITY_MISMATCH" });
  expect(f.calls).toHaveLength(1);
});

test("a failed full catalog and successful View remain independent without any fallback request", async () => {
  const f = await currentNotionFixture();
  f.state.paired = { version: 1, catalog: { ok: false, error: { code: "ACCESS_DENIED" } }, directory: { ok: true, value: directory(f) } };
  const result = await f.sources.discoverSourceCatalog({ sources: [f.source] }, f.root, { directorySelections: new Map([[f.source.id, {}]]) });
  const view = await f.views.resolveViewDiscovery({ sources: [f.source] }, result, { cwd: f.root }, undefined, result.directories);
  expect(view.views?.[0]).toMatchObject({ status: "ready", count: 1 });
  expect(view.failures).toEqual([expect.objectContaining({ code: "ACCESS_DENIED", blocking: false })]);
  expect(f.calls).toHaveLength(1);
});

test("Profile and explicit View preserve their chosen authority and never contaminate full discovery", async () => {
  const f = await currentNotionFixture(), source = { ...f.source, profile_id: "work" };
  const profile = { ...directory(f), capability_directory: true, profile: { library_id: "current-source", library_entry: database,
    profile_id: "work", fingerprint: "c".repeat(64), selection: "profile", source: "notion", freshness: f.state.catalog.freshness } };
  f.state.directory = profile;
  expect((await f.boundary.discoverNotionSource(source, f.root, { defaultView: true })).profileId).toBe("work");
  expect(f.calls[0]?.options).toMatchObject({ defaultView: true, profile: "work" });
  for (const fingerprint of ["profile-" + "c".repeat(64), "C".repeat(64), "c".repeat(63)]) {
    f.state.directory = { ...profile, profile: { ...profile.profile, fingerprint } };
    await expect(f.boundary.discoverNotionSource(source, f.root, { defaultView: true })).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
  }
  f.state.directory = { ...profile, profile: { ...profile.profile, revision_id: "profile-" + "c".repeat(64) } };
  await expect(f.boundary.discoverNotionSource(source, f.root, { defaultView: true })).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
  f.state.directory = profile;
  f.calls.length = 0;
  expect((await f.boundary.discoverNotionSource(source, f.root)).list.exhaustive).toBe(true);
  expect(f.calls[0]?.options).not.toHaveProperty("profile");
  f.state.directory = directory(f);
  await f.boundary.discoverNotionSource(source, f.root, { view: uuid(20) });
  expect(f.calls[1]?.options).toMatchObject({ view: uuid(20) }); expect(f.calls[1]?.options).not.toHaveProperty("profile");
  f.state.catalog = profile;
  await expect(f.boundary.discoverNotionSource(source, f.root)).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
});

test("disabled records are hidden while duplicate logical or physical identities reject the entire source", async () => {
  const f = await currentNotionFixture();
  f.state.catalog.records = [{ ...f.record, enabled: false }];
  expect(await f.boundary.discoverNotionSource(f.source, f.root)).toHaveLength(0);
  for (const second of [f.record, { ...f.record, id: "shared_skill:current-source:other", ref: "skill://shared_skill%3Acurrent-source%3Aother/SKILL.md",
    locator: { ...f.record.locator, skill_id: "other" } }]) {
    f.state.catalog = { ...f.state.catalog, records: [f.record, second], count: 2 };
    await expect(f.boundary.discoverNotionSource(f.source, f.root)).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
  }
  expect(f.calls.every(call => call.operation === "list")).toBe(true);
});

test("directory metadata must prove its physical database, queried source and complete selector scope", async () => {
  for (const defect of ["database", "data-source", "scope", "count", "unsolicited-view"] as const) {
    const f = await currentNotionFixture(), catalog = f.state.catalog;
    if (defect === "database") catalog.databases = [];
    else if (defect === "data-source") catalog.coverage.queried_data_sources = [];
    else if (defect === "scope") catalog.scope = "invalid";
    else if (defect === "count") catalog.count++;
    else Object.assign(catalog, { view: directory(f).view });
    await expect(f.boundary.discoverNotionSource(f.source, f.root)).rejects.toMatchObject({ code: "SOURCE_RESPONSE_INVALID" });
    expect(await exists(f.source.cacheDir!)).toBe(false);
  }
});

test("a partial SDK catalog retains exact returned records without claiming alias uniqueness or absence", async () => {
  const f = await currentNotionFixture();
  Object.assign(f.state.catalog.coverage, { exhaustive: false, failed_sources: [{ id: "unavailable-source", code: "ACCESS_DENIED" }] });
  const records = await f.boundary.discoverNotionSource(f.source, f.root);
  expect(records.list.exhaustive).toBe(false); expect(records.failures).toEqual([expect.objectContaining({ code: "CATALOG_INCOMPLETE", blocking: false })]);
  expect(records[0]?.selectionToken).toContain(page.replaceAll("-", ""));
  f.state.resolve = () => { throw Object.assign(Error("incomplete"), { code: "CATALOG_INCOMPLETE" }); };
  await expect(f.boundary.resolveNotionReference("skill://entry/SKILL.md", [f.source], f.root)).rejects.toMatchObject({ code: "CATALOG_INCOMPLETE" });
  expect(f.calls.every(call => call.operation === "list")).toBe(true);
});

test("current names reuse complete catalog metadata and fixed names use one files operation", async () => {
  const f = await currentNotionFixture();
  const current = await f.boundary.resolveNotionReference("skill://entry/SKILL.md", [f.source], f.root);
  expect(current.record.id).toBe(f.record.id); expect(current.ref).toBe(f.record.ref);
  const fixed = await f.boundary.resolveNotionReference("skill://entry/references/guide.md?snapshot=" + f.snapshot, [f.source], f.root);
  expect(fixed.record.id).toBe(f.record.id); expect(fixed.ref).toBe(f.files[1]!.ref);
  expect(f.calls.map(call => call.operation)).toEqual(["list", "files"]);
  expect(fixed.record.body).toBeUndefined(); expect(await readFile(fixed.record.path, "utf8")).not.toContain(f.body);
  await expect(f.boundary.resolveNotionReference("skill://entry/SKILL.md?snapshot=" + f.snapshot, [{ ...f.source, database: uuid(90) }], f.root))
    .rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
});

test("a fixed alias cannot silently switch owners and source errors preserve their original code", async () => {
  const f = await currentNotionFixture();
  await expect(f.boundary.resolveNotionReference("skill://renamed/SKILL.md?snapshot=" + f.snapshot, [f.source], f.root))
    .rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
  for (const code of ["SNAPSHOT_MISSING", "ACCESS_DENIED", "AUTH_REQUIRED", "STATE_CORRUPT"]) {
    f.state.listFiles = () => { throw Object.assign(Error(code), { code }); };
    await expect(f.boundary.resolveNotionReference("skill://entry/SKILL.md?snapshot=" + f.snapshot, [f.source], f.root)).rejects.toMatchObject({ code });
  }
  expect(f.calls.every(call => call.operation === "files")).toBe(true);
});

test("shared identity encoding and exact selectors preserve the logical and physical owner", () => {
  expect(sharedSkillId("lib:team", "skill:one")).toBe("shared_skill:lib%3Ateam:skill%3Aone");
  expect(sharedSkillId("../unsafe", "skill")).toBeUndefined();
  const record = hostRecord(), precise = preciseRecordToken(record);
  expect(precise).toContain(page.replaceAll("-", "")); expect(matchesPreciseRecordToken(precise, record)).toBe(true);
  expect(normalizeSources([{ type: "notion", id: "shared", database, profile_id: "work" }])?.[0]).toMatchObject({ profile_id: "work" });
  for (const raw of [{ type: "notion", id: "shared", profile_id: "work" }, { type: "notion", id: "shared", database, profile_id: "../unsafe" }])
    expect(() => normalizeSources([raw])).toThrow();
});

async function observeWrite(result: Json, operation = "update") {
  const handlers = new Map<string, unknown>(), changed: string[][] = [];
  const api: ExtensionAPI = { on(event, handler) { handlers.set(event, handler); } };
  const f = await currentNotionFixture();
  const { installCliWriteInvalidation } = await import(pathToFileURL(join(f.root, "src/cli-write-invalidation.ts")).href);
  const { hostCliScope } = await import(pathToFileURL(join(f.root, "src/host-command.ts")).href);
  const source: NotionSource = { type: "notion", id: "shared", namespace: "team", database };
  installCliWriteInvalidation(api, { sources: [source], records: () => [hostRecord()], changed(ids) { changed.push(ids); } });
  const context: ExtensionContext = { sessionManager: { getSessionId: () => "controlled-session" } };
  const call = handlers.get("tool_call"), finish = handlers.get("tool_result");
  if (typeof call !== "function" || typeof finish !== "function") throw new Error("Expected installed write-observer handlers");
  const quoted = (argument: string) => "'" + argument.replaceAll("'", "'\\''") + "'";
  const input = { command: [...hostCliScope([source]).command, operation, sharedRecord().ref, "--database", database].map(quoted).join(" ") };
  await call({ toolName: "bash", toolCallId: "write-1", input }, context);
  await finish({ toolName: "bash", toolCallId: "write-1", input, content: JSON.stringify(result), isError: false }, context);
  return changed;
}
function metadataReceipt(): Json {
  const operation = `metadata-write-${"e".repeat(64)}`;
  return { ok: true, verified: true, status: "applied", operation: "update", action: "updated", operation_id: operation, metadata_operation_id: operation, changed_fields: ["Name"], record: sharedRecord(), scope };
}

test("verified shared metadata updates invalidate their configured library using the real page locator", async () => {
  expect(await observeWrite(metadataReceipt())).toEqual([["shared"]]);
});

const invalidReceipts: [string, (receipt: Json) => Json][] = [
  ["unverified", receipt => ({ ...receipt, verified: false })],
  ["unknown original outcome", receipt => ({ ...receipt, status: "unknown" })],
  ["dry run", receipt => ({ ...receipt, dry_run: true })],
  ["mismatched original operation", receipt => ({ ...receipt, operation_id: `metadata-write-${"f".repeat(64)}` })],
  ["empty properties", receipt => ({ ...receipt, changed_fields: [] })],
  ["different credential scope", receipt => ({ ...receipt, scope: "f".repeat(64) })],
  ["logical id used as page", receipt => ({ ...receipt, record: { ...sharedRecord(), locator: { ...sharedRecord().locator, page_id: "skill:one" } } })],
  ["missing stable identity", receipt => ({ ...receipt, record: { ...sharedRecord(), id: undefined, locator: { ...sharedRecord().locator, library_id: "../bad" } } })],
  ["wrong canonical ref", receipt => ({ ...receipt, record: { ...sharedRecord(), ref: `skill://${page}/SKILL.md` } })],
];
test.each(invalidReceipts)("shared invalidation refuses %s", async (_name, change) => {
  expect(await observeWrite(change(metadataReceipt()))).toEqual([]);
});

function sharedWriteReceipt(): Json {
  return { ok: true, verified: true, operation: "write", action: "updated", unchanged: false,
    record: sharedRecord(), scope, snapshot_id: snapshot, version_id: "verified-current-version",
    body_write_operation_id: `body-write-adopt-${"e".repeat(64)}.${"f".repeat(64)}`, candidate_sha256: "c".repeat(64) };
}
function sharedApplyReceipt(): Json {
  return { ok: true, verified: true, operation: "apply", status: "applied", record: sharedRecord(), scope,
    snapshot_id: snapshot, version_id: "verified-current-version", apply_operation_id: `skill-apply-${"e".repeat(64)}.${"f".repeat(64)}`,
    changes: { files: ["SKILL.md", "references/updated.md"], removed: [] } };
}

test("verified shared write and apply refresh discovery using their own public receipts", async () => {
  expect(await observeWrite(sharedWriteReceipt(), "write")).toEqual([["shared"]]);
  expect(await observeWrite(sharedApplyReceipt(), "apply")).toEqual([["shared"]]);
  expect(await observeWrite({ ...sharedApplyReceipt(), operation: "replace" }, "apply")).toEqual([["shared"]]);
  expect(await observeWrite({ ...sharedApplyReceipt(), changes: { files: [], removed: [] } }, "apply")).toEqual([["shared"]]);
});

test("a shared one-file layout apply uses its original lifecycle identity", async () => {
  expect(await observeWrite({ ...sharedApplyReceipt(), apply_operation_id: `file-management-delete-${"e".repeat(64)}.${"f".repeat(64)}`,
    changes: { files: [], removed: ["references/removed.md"] } }, "apply")).toEqual([["shared"]]);
});

test("unresolved, unchanged and planned shared body or batch operations never refresh discovery", async () => {
  for (const result of [
    { ...sharedWriteReceipt(), action: "unchanged", unchanged: true },
    { ...sharedWriteReceipt(), status: "unknown" },
    { ...sharedWriteReceipt(), body_write_operation_id: undefined },
    { ...sharedApplyReceipt(), status: "partial" },
    { ...sharedApplyReceipt(), status: "unchanged", unchanged: true },
    { ...sharedApplyReceipt(), status: "planned", dry_run: true },
    { ...sharedApplyReceipt(), apply_operation_id: "foreign-operation" },
    { ...sharedApplyReceipt(), verified: false },
  ]) expect(await observeWrite(result, String(result.operation))).toEqual([]);
});

test("shared create refreshes only a verified newly created Skill, not a reuse or missing original identity", async () => {
  const created = { ...sharedApplyReceipt(), operation: "create", action: "create", create_operation_id: `skill-create-${"e".repeat(64)}`, reused: false };
  expect(await observeWrite(created, "create")).toEqual([["shared"]]);
  expect(await observeWrite({ ...created, reused: true }, "create")).toEqual([]);
  expect(await observeWrite({ ...created, create_operation_id: undefined }, "create")).toEqual([]);
});
