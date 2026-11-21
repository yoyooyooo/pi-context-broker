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
const database = uuid(10), dataSource = uuid(11), page = uuid(1), scope = "a".repeat(64);
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

const importOperation = "current-import:adapter";
const currentLibrary = { library_id: "current-source", database_id: database, data_source_id: dataSource };
async function observeWrite(result: Json, options: {
  resume?: boolean; supersede?: string; isError?: boolean; entry?: string; operation?: string;
  native?: string[];
  source?: { kind: "apply" }
    | { kind: "refresh" | "enable" | "disable" | "remove"; sourceId: string }
    | { kind: "takeover" | "restore-follow"; sourceId: string; path: string; fileId: string };
} = {}) {
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
  const route = options.source === undefined ? ["import", "/staged", "--skill-id", "entry"]
    : options.source.kind === "apply" ? ["source", "apply", "/not-opened/source.json"]
    : "path" in options.source ? ["source", options.source.kind, options.source.sourceId, options.source.path,
      "--skill-id", "entry", "--file-id", options.source.fileId]
    : ["source", options.source.kind, options.source.sourceId];
  const input = { command: [...hostCliScope([source]).command, "ctl", "library", ...route,
    "--entry", options.entry ?? database, "--operation", options.operation ?? importOperation,
    ...(options.native ?? []).flatMap(path => ["--native", path]),
    ...(options.resume ? ["--resume"] : []),
    ...(options.supersede ? ["--supersede", options.supersede] : [])].map(quoted).join(" ") };
  await call({ toolName: "bash", toolCallId: "write-1", input }, context);
  await finish({ toolName: "bash", toolCallId: "write-1", input, content: JSON.stringify(result), isError: options.isError ?? false }, context);
  expect(f.calls).toHaveLength(0);
  return changed;
}
function currentImportResult(): Json {
  return { ok: true, contract: "current", status: "applied", state: "ready", operation_id: importOperation,
    skill_id: "entry", page_id: page, input_sha256: "c".repeat(64), files: 3, library: currentLibrary };
}

test("a complete current import invalidates the same library used by the SDK directory", async () => {
  expect(await observeWrite(currentImportResult())).toEqual([["shared"]]);
});

test("rebuilding the same stable Skill on a new page refreshes discovery without adopting returned content", async () => {
  expect(await observeWrite({ ...currentImportResult(), page_id: uuid(99) })).toEqual([["shared"]]);
});

test("native imports and their same-intent resumes invalidate the current SDK directory", async () => {
  const native = ["SKILL.md", "references/guide.md"];
  expect(await observeWrite(currentImportResult(), { native })).toEqual([["shared"]]);
  expect(await observeWrite({ ...currentImportResult(), status: "unchanged" }, { native, resume: true })).toEqual([["shared"]]);
});

const invalidImports: [string, (result: Json) => Json][] = [
  ["non-current contract", result => ({ ...result, contract: "snapshot" })],
  ["unknown original outcome", result => ({ ...result, status: "unknown" })],
  ["incomplete state", result => ({ ...result, state: "pending" })],
  ["dry run", result => ({ ...result, dry_run: true })],
  ["mismatched original operation", result => ({ ...result, operation_id: "another-import" })],
  ["missing operation identity", result => ({ ...result, operation_id: undefined })],
  ["different stable Skill", result => ({ ...result, skill_id: "another-entry" })],
  ["logical id used as page", result => ({ ...result, page_id: "entry" })],
  ["different library identity", result => ({ ...result, library: { ...currentLibrary, library_id: "another-library" } })],
  ["different database", result => ({ ...result, library: { ...currentLibrary, database_id: uuid(99) } })],
  ["different data source", result => ({ ...result, library: { ...currentLibrary, data_source_id: uuid(99) } })],
  ["invalid logical library", result => ({ ...result, library: { ...currentLibrary, library_id: "../bad" } })],
  ["missing library binding", result => ({ ...result, library: undefined })],
  ["empty complete tree", result => ({ ...result, files: 0 })],
  ["invalid complete input hash", result => ({ ...result, input_sha256: "not-a-hash" })],
];
test.each(invalidImports)("current invalidation refuses %s", async (_name, change) => {
  expect(await observeWrite(change(currentImportResult()))).toEqual([]);
});

test("ordinary unchanged imports are inert, while exact resume may recover earlier write visibility", async () => {
  const unchanged = { ...currentImportResult(), status: "unchanged" };
  expect(await observeWrite(unchanged)).toEqual([]);
  expect(await observeWrite(unchanged, { resume: true })).toEqual([["shared"]]);
  expect(await observeWrite(unchanged, { resume: true, operation: "other-import" })).toEqual([]);
});

test("a failed current operation dirties its directory without claiming successful completion", async () => {
  const failure = { ok: false, error: { code: "CURRENT_WRITE_OUTCOME_UNKNOWN", details: { operation_id: importOperation, skill_id: "entry" } } };
  expect(await observeWrite(failure, { isError: true })).toEqual([["shared"]]);
  expect(await observeWrite(failure, { isError: false })).toEqual([["shared"]]);
  expect(await observeWrite(failure, { isError: true, operation: "another-import" })).toEqual([]);
  expect(await observeWrite(failure, { isError: true, entry: uuid(99) })).toEqual([]);
  expect(await observeWrite({ ok: false, error: { code: "INVALID_ARGUMENT" } }, { isError: true })).toEqual([]);
  expect(await observeWrite({ ok: false, error: { details: { operation_id: importOperation, skill_id: "different-entry" } } }, { isError: true })).toEqual([]);
});

test("a configured display name or old publication receipt never binds a current import", async () => {
  expect(await observeWrite(currentImportResult(), { entry: "entry" })).toEqual([]);
  expect(await observeWrite({ ok: true, verified: true, operation: "apply", status: "applied", record: sharedRecord(), scope,
    apply_operation_id: "skill-apply-" + "e".repeat(64) + "." + "f".repeat(64), changes: { files: ["SKILL.md"], removed: [] } })).toEqual([]);
});

const managedSourceId = "git-repository";
function currentSourceResult(status: "applied" | "unchanged" = "applied"): Json {
  const { ok: _ok, ...target } = currentImportResult();
  return { ok: true, version: 1, contract: "current", action: "declaration", status, state: "ready",
    library: currentLibrary, sources_data_source_id: uuid(12), source_id: managedSourceId, source_page_id: uuid(90),
    operation_id: importOperation, input_sha256: "d".repeat(64), configuration_sha256: "e".repeat(64),
    revision: "f".repeat(64), resolved_commit: "a".repeat(40), affected_skill_ids: ["entry", "new-entry"],
    targets: [{ ...target, status }, { ...target, status, skill_id: "new-entry", page_id: uuid(2), operation_id: "source-target:second" }] };
}

test("one Source apply or refresh invalidates its exact SDK library after all current targets complete", async () => {
  expect(await observeWrite(currentSourceResult(), { source: { kind: "apply" } })).toEqual([["shared"]]);
  expect(await observeWrite(currentSourceResult(), { source: { kind: "refresh", sourceId: managedSourceId } })).toEqual([["shared"]]);
  expect(await observeWrite(currentSourceResult(), { source: { kind: "refresh", sourceId: "another-source" } })).toEqual([]);
  expect(await observeWrite(currentSourceResult())).toEqual([]);
  expect(await observeWrite(currentImportResult(), { source: { kind: "apply" } })).toEqual([]);
});

test("completed upstream member deletion invalidates discovery after partial or complete retirement", async () => {
  const value = currentSourceResult();
  const targets = value.targets as Json[];
  const removed = (target: Json): Json => ({ ...target, state: "removed", status: "removed", files: 0 });
  expect(await observeWrite({ ...value, targets: [targets[0], removed(targets[1]!)] },
    { source: { kind: "refresh", sourceId: managedSourceId } })).toEqual([["shared"]]);
  expect(await observeWrite({ ...value, targets: targets.map(removed) },
    { source: { kind: "refresh", sourceId: managedSourceId } })).toEqual([["shared"]]);
  expect(await observeWrite({ ...value, targets: [targets[0], { ...removed(targets[1]!), files: 1 }] },
    { source: { kind: "refresh", sourceId: managedSourceId } })).toEqual([]);
});

const invalidSourceWrites: [string, (result: Json) => Json][] = [
  ["missing current action", result => ({ ...result, action: undefined })],
  ["wrong current action", result => ({ ...result, action: "enabled", enabled: true })],
  ["non-ready Source", result => ({ ...result, state: "pending" })],
  ["Source inspection", result => ({ ...result, status: "inspected", remote_writes: 0 })],
  ["missing Source page", result => ({ ...result, source_page_id: null })],
  ["invalid Source identity", result => ({ ...result, source_id: "../source" })],
  ["missing Source table", result => ({ ...result, sources_data_source_id: undefined })],
  ["Skills table used for Source", result => ({ ...result, sources_data_source_id: dataSource })],
  ["foreign library", result => ({ ...result, library: { ...currentLibrary, library_id: "another-library" } })],
  ["incomplete target set", result => ({ ...result, affected_skill_ids: ["entry", "new-entry", "missing"] })],
  ["duplicate affected identity", result => ({ ...result, affected_skill_ids: ["entry", "entry"] })],
  ["missing completed targets", result => ({ ...result, targets: [] })],
  ["missing exact commit", result => ({ ...result, resolved_commit: undefined })],
  ["missing declaration hash", result => ({ ...result, configuration_sha256: undefined })],
];
test.each(invalidSourceWrites)("Source invalidation refuses %s", async (_name, change) => {
  expect(await observeWrite(change(currentSourceResult()), { source: { kind: "apply" } })).toEqual([]);
});

test("Source no-op apply is inert while same-intent resume recovers prior visibility", async () => {
  const unchanged = currentSourceResult("unchanged");
  expect(await observeWrite(unchanged, { source: { kind: "apply" } })).toEqual([]);
  expect(await observeWrite(unchanged, { source: { kind: "refresh", sourceId: managedSourceId } })).toEqual([]);
  expect(await observeWrite(unchanged, { source: { kind: "apply" }, resume: true })).toEqual([["shared"]]);
  expect(await observeWrite(unchanged, { source: { kind: "refresh", sourceId: managedSourceId }, resume: true })).toEqual([["shared"]]);
});

test("a Source outcome unknown uses its finite parent intent without claiming a child or completion", async () => {
  const details = { owner: { kind: "source", id: managedSourceId }, source_id: managedSourceId,
    operation_id: importOperation, input_sha256: "d".repeat(64), next: "reconcile_current" };
  const unknown = { ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN", details } };
  for (const isError of [false, true])
    expect(await observeWrite(unknown, { source: { kind: "apply" }, isError })).toEqual([["shared"]]);
  expect(await observeWrite(unknown, { source: { kind: "refresh", sourceId: managedSourceId } })).toEqual([["shared"]]);
  expect(await observeWrite(unknown, { source: { kind: "refresh", sourceId: "another-source" } })).toEqual([]);
  expect(await observeWrite(unknown, { source: { kind: "apply" }, operation: "another-intent" })).toEqual([]);
  expect(await observeWrite(unknown, { source: { kind: "apply" }, entry: uuid(99) })).toEqual([]);
  for (const changed of [
    { ...details, owner: { kind: "skill", id: "entry" }, skill_id: "entry" },
    { ...details, owner: { kind: "source", id: "another-source" } },
    { ...details, operation_id: undefined }, { ...details, input_sha256: undefined }, { ...details, next: undefined },
  ]) expect(await observeWrite({ ok: false, error: { details: changed } }, { source: { kind: "apply" } })).toEqual([]);
  expect(await observeWrite({ ok: false, error: { code: "INVALID_ARGUMENT" } }, { source: { kind: "apply" } })).toEqual([]);
});


test("current Source eligibility and retirement metadata invalidate the paired SDK directory", async () => {
  const { resolved_commit: _commit, ...base } = currentSourceResult();
  const targets = [{ skill_id: "entry", skill_page_id: page }, { skill_id: "new-entry", skill_page_id: uuid(2) }];
  for (const kind of ["enable", "disable"] as const) {
    const value = { ...base, action: "enabled", enabled: kind === "enable", targets };
    const source = { kind, sourceId: managedSourceId };
    expect(await observeWrite(value, { source })).toEqual([["shared"]]);
    expect(await observeWrite({ ...value, status: "unchanged" }, { source })).toEqual([]);
    expect(await observeWrite({ ...value, status: "unchanged" }, { source, supersede: "previous-intent" })).toEqual([["shared"]]);
    expect(await observeWrite({ ...value, enabled: kind !== "enable" }, { source })).toEqual([]);
    expect(await observeWrite(currentSourceResult(), { source })).toEqual([]);
  }
  const value = { ...base, action: "remove", state: "removed", status: "removed", targets };
  expect(await observeWrite(value, { source: { kind: "remove", sourceId: managedSourceId } })).toEqual([["shared"]]);
  expect(await observeWrite({ ...value, state: "ready" }, { source: { kind: "remove", sourceId: managedSourceId } })).toEqual([]);
});

test("current Source file authority results bind the selected File and path before SDK discovery invalidation", async () => {
  const { resolved_commit: _commit, ...base } = currentSourceResult();
  const { ok: _ok, ...target } = currentImportResult();
  for (const kind of ["takeover", "restore-follow"] as const) {
    const source = { kind, sourceId: managedSourceId, path: "skills/entry/SKILL.md", fileId: "main-entry" };
    const value = { ...base, action: kind === "takeover" ? "takeover" : "restore_follow", file_id: source.fileId,
      source_path: source.path, affected_skill_ids: ["entry"], targets: [target] };
    expect(await observeWrite(value, { source })).toEqual([["shared"]]);
    expect(await observeWrite(value, { source: { ...source, fileId: "another-file" } })).toEqual([]);
    expect(await observeWrite(value, { source: { ...source, path: "skills/entry/other.md" } })).toEqual([]);
    expect(await observeWrite(currentSourceResult(), { source })).toEqual([]);
  }
});
