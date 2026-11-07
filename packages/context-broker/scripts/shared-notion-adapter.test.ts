import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installCliWriteInvalidation } from "../src/cli-write-invalidation";
import { formatFindDiagnostics } from "../src/diagnostics";
import { matchesPreciseRecordToken, parseCatalogMember, preciseRecordToken, resolveCatalogReference } from "../src/discovery-records";
import { hostCliScope } from "../src/host-command";
import { installHostSkills } from "../src/host-skills";
import { discoverNotionCatalogAndDirectory, discoverNotionSource, loadNotionSkill, ReferenceMiss, resolveNotionReference } from "../src/notion-source";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { sharedSkillId } from "../src/shared-skill-identity";
import { discoverSourceCatalog, normalizeSources } from "../src/sources";
import { resolveViewDiscovery, VIEW_SELECTION_ENTRY } from "../src/view-discovery";
import type { ContentRecord, ExtensionAPI, ExtensionContext, NotionDirectoryObservation, PiReadDefinition, SessionEntry, SkillRecord, SourceConfig } from "../src/types";

type NotionSource = Extract<SourceConfig, { type: "notion" }>;
type Json = Record<string, unknown>;
const node = process.versions.bun ? execFileSync("node", ["--print", "process.execPath"], { encoding: "utf8" }).trim() : process.execPath;
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const database = uuid(1), dataSource = uuid(2), page = uuid(3), view = uuid(4), scope = "a".repeat(64);
const snapshot = `s_${"b".repeat(64)}`;
const freshness = () => ({ policy: "default", validated_at: new Date().toISOString(), age_ms: 0, max_age_ms: 3_600_000, stale: false });
function sharedRecord(skillId = "skill:one", options: { page?: string; enabled?: boolean; kind?: ContentRecord["kind"] } = {}): ContentRecord {
  const kind = options.kind ?? "skill", entrypoint = { skill: "SKILL.md", router: "ROUTER.md", prompt: "PROMPT.md" }[kind];
  const id = `shared_skill:lib%3Ateam:${encodeURIComponent(skillId)}`;
  return { id, kind, locator: { type: "shared_skill", library_id: "lib:team", skill_id: skillId, page_id: options.page ?? page, database_id: database, data_source_id: dataSource }, name: "Shared " + skillId, alias: "shared", description: "A controlled shared record", default_context: false, enabled: options.enabled ?? true, entrypoint, ref: `skill://${encodeURIComponent(id)}/${entrypoint}` };
}
function listing(records: readonly unknown[], mode: "full" | "profile" | "view" = "full"): Json {
  return { ok: true, records, count: records.length, fetched_at: Date.now(), scope, freshness: freshness(),
    databases: [{ database_id: database, title: "Shared", alias: "shared", role: "content", data_source_ids: [dataSource] }],
    coverage: { method: mode === "full" ? "explicit_database" : "explicit_view", exhaustive: true, search_index_limited: false, queried_data_sources: [dataSource], failed_sources: [] },
    ...(mode === "full" ? {} : { view_selection: "explicit", view: { id: view, name: "Selected", type: "table", database_id: database, data_source_id: dataSource, url: `https://notion.so/${database}?v=${view}` } }),
    ...(mode !== "profile" ? {} : { capability_directory: true, profile: { library_id: "lib:team", library_entry: database, profile_id: "work", revision_id: `profile-${"c".repeat(64)}`, selection: "profile", source: "notion", freshness: freshness() } }),
  };
}
function hostRecord(record = sharedRecord()): SkillRecord {
  return { ...record, source: "notion", sourceId: "shared", sourceScope: scope, aliases: [], autoloadEnabled: record.kind !== "prompt", path: "/metadata/" + record.entrypoint, normalizedName: record.alias, normalizedAliases: [], normalizedDescription: record.description, token: "team/" + record.alias };
}
async function fixture(input: { records?: readonly unknown[]; profile?: boolean } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "broker-shared-adapter-"));
  // Keep the isolated fixture for review; these tests never permanently delete files.
  const statePath = join(root, "state.json"), logPath = join(root, "calls.jsonl"), executable = join(root, "controlled-cli.mjs");
  const record = sharedRecord(), content = "---\nname: shared\ndescription: controlled\n---\nFixed shared body\n";
  const read = { ok: true, record, content, snapshot_id: snapshot, version_id: "version-controlled", scope, entrypoint: record.entrypoint, path: record.entrypoint, ref: `${record.ref}?snapshot=${snapshot}`, range: { start: 1, end: content.split("\n").length, total_lines: content.split("\n").length }, has_more: false, freshness: freshness() };
  const state: Json = { catalog: listing(input.records ?? [record]), profile: listing([record], "profile"), explicit: listing([record], "view"), read,
    files: { ok: true, record, snapshot_id: snapshot, version_id: read.version_id, scope, entrypoint: record.entrypoint, ref: read.ref, freshness: { policy: "pinned" },
      files: [{ path: record.entrypoint, bytes: Buffer.byteLength(content), ref: read.ref }, { path: "scripts/fixed.bin", bytes: 4, ref: record.ref.replace(record.entrypoint, "scripts/fixed.bin") + `?snapshot=${snapshot}` }] },
    resources: { "scripts/fixed.bin": Buffer.from([0, 255, 13, 10]).toString("base64") } };
  await writeFile(logPath, "", { mode: 0o600 });
  await writeFile(executable, `
import {readFileSync,appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const [statePath,logPath,...args]=process.argv.slice(2),state=JSON.parse(readFileSync(statePath,'utf8'));
appendFileSync(logPath,JSON.stringify(args)+'\\n');
let value;
if(args[0]==='ctl'&&args[1]==='cache'&&args[2]==='identity')value={ok:true,identity:'a'.repeat(64),catalog_max_age_ms:3600000};
else if(args[0]==='list')value=state.pages?state.pages[args.includes('--cursor')?args[args.indexOf('--cursor')+1]:'first']:args.includes('--view')?state.explicit:args.includes('--default-view')?state.profile:state.catalog;
else if(args[0]==='read')value=state.read;
else if(args[0]==='files')value=state.files;
else if(args[0]==='export'){
 const read=state.read,output=args[args.indexOf('--output')+1];
 const manifest={format:'ntn-skills',version:2,kind:read.record.kind,main:read.entrypoint,name:read.record.name,description:read.record.description};
 const content={...Object.fromEntries(Object.entries(state.resources).map(([path,base64])=>[path,Buffer.from(base64,'base64')])),[read.entrypoint]:Buffer.from(read.content),'.ntn-skills.json':Buffer.from(JSON.stringify(manifest))};
 const files=Object.entries(content).map(([path,bytes])=>{const dest=join(output,path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,bytes);return {path,bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex'),role:path===read.entrypoint?'entrypoint':path==='.ntn-skills.json'?'manifest':'resource'};});
 value={ok:true,record:read.record,scope:read.scope,snapshot_id:read.snapshot_id,version_id:read.version_id,entrypoint:read.entrypoint,ref:read.ref,operation:'export',projection:'snapshot',format:'directory',output,reused:false,main_path:read.entrypoint,content_id:'d'.repeat(64),files,freshness:{policy:'pinned'}};
}else value={ok:false,error:{code:'INVALID_ARGUMENT'}};
process.stdout.write(JSON.stringify(value));if(value.ok!==true)process.exitCode=1;
`, { mode: 0o600 });
  const save = () => writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  await save();
  const source: NotionSource = { type: "notion", id: "shared", namespace: "team", database, command: [node, executable, statePath, logPath], cacheDir: join(root, "cache"), ...(input.profile ? { profile_id: "work" } : {}) };
  return { root, source, state, save, read, record, content, statePath, logPath,
    calls: async (): Promise<string[][]> => (await readFile(logPath, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)),
    clearCalls: () => writeFile(logPath, ""),
  };
}

async function pairedSdkFixture() {
  const f = await fixture(), sdk = join(f.root, "controlled-sdk.ts"), source = join(f.root, "isolated-notion-source.ts");
  const parent = resolve(import.meta.dirname, "../src");
  await writeFile(sdk, [
    'import { readFileSync, appendFileSync } from "node:fs";',
    'const read = () => JSON.parse(readFileSync(' + JSON.stringify(f.statePath) + ', "utf8"));',
    'export class NotionSdkError extends Error { code; constructor(code) { super(code); this.code = code; } }',
    'export const supportsNotionSdkCatalogDirectory = async () => read().sdkSupportsPair !== false;',
    'export async function listNotionCatalogSdk(options) { appendFileSync(' + JSON.stringify(f.logPath) + ', JSON.stringify(["sdk-list", JSON.stringify({ directory: options.directory, refresh: options.refresh, offline: options.offline })]) + "\\n"); return read().paired; }',
    'const unexpected = () => { throw Error("Unexpected SDK operation in metadata-only source test"); };',
    'export const consumeNotionSdk = unexpected, readNotionSdk = unexpected, readNotionResourcesSdk = unexpected, resolveNotionCatalogReferenceSdk = unexpected, listNotionFilesSdk = unexpected, supportsNotionSdkReadOutputProof = unexpected, parseNotionSdkDuration = unexpected;',
  ].join("\n"));
  const original = await readFile(join(parent, "notion-source.ts"), "utf8");
  await writeFile(source, original.replace(/from "\.\/([^"]+)"/g, (_whole, name: string) => 'from ' + JSON.stringify(name === "notion-sdk" ? sdk : join(parent, name + ".ts")))
    .replace('from "effect"', 'from ' + JSON.stringify(import.meta.resolve("effect"))));
  const boundary: typeof import("../src/notion-source") = await import(pathToFileURL(source).href);
  const paired = { version: 1, catalog: { ok: true, value: listing([]) }, directory: { ok: true, value: listing([f.record], "profile") } };
  f.state.paired = paired; await f.save();
  return { ...f, boundary, paired, source: { ...f.source, command: undefined } };
}

test("repeated SDK metadata observations reuse their immutable index while preserving current authority and freshness", async () => {
  const f = await pairedSdkFixture();
  f.paired.catalog.value = listing([f.record]); await f.save();
  const observe = () => f.boundary.discoverNotionCatalogAndDirectory(f.source, f.root, {});
  const first = await observe();
  if (!first?.catalog.ok || !first.directory.ok) throw new Error("Expected both metadata projections");
  const path = first.catalog.value[0]!.metadataIndexPath!;
  expect(first.directory.value[0]!.metadataIndexPath).toBe(path);
  const indexes = join(f.source.cacheDir!, "scopes", scope, "indexes");
  const before = await readdir(indexes);
  f.paired.catalog.value = listing([f.record]);
  f.paired.directory.value = listing([f.record], "profile"); await f.save();
  const second = await observe();
  if (!second?.catalog.ok || !second.directory.ok) throw new Error("Expected the refreshed metadata projections");
  expect(second.catalog.value[0]!.metadataIndexPath).toBe(path);
  expect(second.directory.value[0]!.metadataIndexPath).toBe(path);
  expect(second.catalog.value[0]!.freshness).toEqual(f.paired.catalog.value.freshness);
  expect(await readdir(indexes)).toEqual(before);
  expect((await f.calls()).map(call => call[0])).toEqual(["sdk-list", "sdk-list"]);
  const original = await readFile(path, "utf8");
  f.paired.catalog.value = listing([{ ...f.record, description: "Changed metadata" }]); await f.save();
  const changed = await observe();
  if (!changed?.catalog.ok) throw new Error("Expected the changed catalog");
  expect(changed.catalog.value[0]!.metadataIndexPath).not.toBe(path);
  expect(await readFile(changed.catalog.value[0]!.metadataIndexPath!, "utf8")).toContain("Changed metadata");
  expect(await readFile(path, "utf8")).toBe(original);
  const otherScope = "f".repeat(64);
  f.paired.catalog.value.scope = otherScope; f.paired.directory.value.scope = otherScope; await f.save();
  const other = await observe();
  if (!other?.catalog.ok) throw new Error("Expected the other source scope");
  expect(other.catalog.value[0]!.metadataIndexPath).toContain(join("scopes", otherScope, "indexes"));
  expect(await readFile(path, "utf8")).toBe(original);
  f.state.paired = { ...f.paired, catalog: { ok: false, error: { code: "ACCESS_DENIED" } } }; await f.save();
  expect((await observe())?.catalog).toEqual({ ok: false, code: "ACCESS_DENIED" });
});

test("simultaneous SDK metadata discovery publishes one complete shared index", async () => {
  const f = await pairedSdkFixture();
  f.paired.catalog.value = listing([f.record]); await f.save();
  const outcomes = await Promise.all(Array.from({ length: 3 }, () => f.boundary.discoverNotionCatalogAndDirectory(f.source, f.root, {})));
  const paths = outcomes.flatMap(result => {
    if (!result?.catalog.ok || !result.directory.ok) throw new Error("Expected complete concurrent metadata");
    return [result.catalog.value[0]!.metadataIndexPath!, result.directory.value[0]!.metadataIndexPath!];
  });
  expect(new Set(paths).size).toBe(1);
  expect(await readFile(paths[0]!, "utf8")).toContain(f.record.description);
  const indexes = await readdir(join(f.source.cacheDir!, "scopes", scope, "indexes"));
  expect(indexes.filter(name => /^[a-f0-9]{64}$/.test(name))).toHaveLength(1);
  if (process.platform === "darwin") expect(indexes).toHaveLength(1);
});

test("paired SDK source rejects a different directory scope even when its successful full catalog has no rows", async () => {
  const f = await pairedSdkFixture();
  f.paired.directory.value.scope = "f".repeat(64); await f.save();
  const result = await f.boundary.discoverNotionCatalogAndDirectory(f.source, f.root, {});
  if (!result?.catalog.ok) throw new Error("Expected the successful empty full catalog");
  expect(result.catalog.value).toHaveLength(0);
  expect(result?.directory).toEqual({ ok: false, code: "SOURCE_IDENTITY_MISMATCH" });
  expect((await f.calls()).map(call => call[0])).toEqual(["sdk-list"]);
});

test("paired SDK source keeps both outcomes independent and returns no paired result for an old SDK", async () => {
  const f = await pairedSdkFixture();
  f.state.paired = { ...f.paired, catalog: { ok: false, error: { code: "ACCESS_DENIED" } } }; await f.save();
  const result = await f.boundary.discoverNotionCatalogAndDirectory(f.source, f.root, {});
  expect(result?.catalog).toEqual({ ok: false, code: "ACCESS_DENIED" });
  expect(result?.directory).toMatchObject({ ok: true });
  if (!result?.directory.ok) throw new Error("Expected the independent complete directory");
  expect(result.directory.value.map(record => record.id)).toEqual([f.record.id]);
  expect((await f.calls()).map(call => call[0])).toEqual(["sdk-list"]);
  f.state.sdkSupportsPair = false; await f.save(); await f.clearCalls();
  expect(await f.boundary.discoverNotionCatalogAndDirectory(f.source, f.root, {})).toBeUndefined();
  expect(await f.calls()).toEqual([]);
});

test("explicit command discovery retains its original full then selected directory routes", async () => {
  const f = await fixture({ profile: true });
  expect(await discoverNotionCatalogAndDirectory(f.source, f.root, { profile: "work" })).toBeUndefined();
  expect(await f.calls()).toEqual([]);
  const catalog = await discoverSourceCatalog({ sources: [f.source] }, f.root, { directorySelections: new Map([[f.source.id, { profile: "work" }]]) });
  expect(catalog.directories).toBeUndefined();
  const selected = await resolveViewDiscovery({ sources: [f.source] }, catalog, { cwd: f.root });
  expect(selected.views?.[0]).toMatchObject({ status: "ready", origin: "profile" });
  expect((await f.calls()).filter(args => args[0] === "list")).toEqual([
    ["list", "--database", database], ["list", "--database", database, "--default-view", "--profile", "work"],
  ]);
});

test("mismatched paired View or Profile selectors fall back to the current authoritative selection", async () => {
  const f = await fixture({ profile: true });
  const directory = await discoverNotionSource(f.source, f.root, { defaultView: true });
  const catalog = { records: await discoverNotionSource(f.source, f.root), failures: [] };
  for (const explicit of [false, true]) {
    await f.clearCalls();
    const paired = new Map<string, NotionDirectoryObservation>([[f.source.id, { selection: explicit ? { view: uuid(99) } : { profile: "other-profile" }, outcome: { ok: true, value: directory } }]]);
    const ctx: ExtensionContext = { cwd: f.root, ...(explicit ? { sessionManager: { getBranch: () => [{ type: "custom", customType: VIEW_SELECTION_ENTRY, data: { version: 1, sourceId: f.source.id, viewId: view } }] } } : {}) };
    const result = await resolveViewDiscovery({ sources: [f.source] }, catalog, ctx, undefined, paired);
    expect(result.views?.[0]).toMatchObject({ status: "ready", origin: explicit ? "session" : "profile" });
    expect(await f.calls()).toEqual([explicit ? ["list", "--database", database, "--view", view] : ["list", "--database", database, "--default-view", "--profile", "work"]]);
  }
});

test("shared identities encode each logical component and retain the actual page locator", async () => {
  expect(sharedSkillId("lib:team", "skill:one")).toBe("shared_skill:lib%3Ateam:skill%3Aone");
  expect(sharedSkillId("lib/team", "skill")).toBeUndefined();
  const f = await fixture(), result = await discoverNotionSource(f.source, f.root);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ id: "shared_skill:lib%3Ateam:skill%3Aone", enabled: true, locator: { page_id: page }, ref: "skill://shared_skill%3Alib%253Ateam%3Askill%253Aone/SKILL.md" });
  expect((await f.calls()).some(args => ["read", "export", "files"].includes(args[0]!))).toBe(false);
  expect(await readFile(result[0]!.path, "utf8")).not.toContain("Fixed shared body");
});

test("custom-command discovery follows bounded pages before publishing complete metadata", async () => {
  const f = await fixture(), first = sharedRecord("first"), second = sharedRecord("second", { page: uuid(9) });
  const initial = listing([first]);
  f.state.pages = { first: { ...initial, total_count: 2, has_more: true, next_cursor: "second-page" },
    "second-page": { ...initial, records: [second], total_count: 2, has_more: false, next_cursor: null } };
  await f.save();
  const records = await discoverNotionSource(f.source, f.root, { refresh: true });
  expect(records.map(record => record.id)).toEqual([first.id, second.id]);
  expect(records.list.exhaustive).toBe(true);
  const calls = await f.calls(), pages = calls.filter(args => args[0] === "list");
  expect(pages).toHaveLength(2);
  expect(pages[0]).toContain("--refresh");
  expect(pages[1]).toContain("--offline");
  expect(pages[1]).not.toContain("--refresh");
  expect(pages[1].slice(-2)).toEqual(["--cursor", "second-page"]);
  expect(calls.some(args => ["read", "prepare", "export", "files"].includes(args[0]!))).toBe(false);
  expect((await discoverNotionSource(f.source, f.root)).map(record => record.id)).toEqual([first.id, second.id]);
  expect((await f.calls()).filter(args => args[0] === "list")).toHaveLength(2);
});

test("custom-command pagination cannot bless missing cursors, changing scopes or incomplete totals", async () => {
  for (const defect of ["missing-cursor", "scope", "incomplete-total", "repeated-cursor"]) {
    const f = await fixture(), initial = listing([f.record]);
    f.state.pages = { first: { ...initial, total_count: 2, has_more: true, next_cursor: defect === "missing-cursor" ? null : "next" },
      next: { ...initial, ...(defect === "scope" ? { scope: "b".repeat(64) } : {}), records: [], count: 0, total_count: 2,
        has_more: defect === "repeated-cursor", next_cursor: defect === "repeated-cursor" ? "next" : null } };
    await f.save();
    await expect(discoverNotionSource(f.source, f.root)).rejects.toMatchObject({ code: defect === "scope" ? "SOURCE_IDENTITY_MISMATCH" : "SOURCE_RESPONSE_INVALID" });
  }
});

test("SC25 fixed names retain their manifest owner without looking up the current name", async () => {
  const f = await fixture(), other = sharedRecord("new-owner", { page: uuid(50) });
  f.state.catalog = listing([{ ...other, name: f.record.name, alias: f.record.alias }]); await f.save();
  const paths: string[] = [];
  for (const selector of [f.record.name, f.record.alias]) {
    const input = `skill://${encodeURIComponent(selector)}/scripts/fixed.bin?snapshot=${snapshot}`;
    const selected = await resolveNotionReference(input, [f.source], f.root);
    expect(selected.record).toMatchObject({ id: f.record.id, sourceId: f.source.id, sourceScope: scope, snapshotId: snapshot });
    expect(selected.ref).toBe(f.record.ref.replace("SKILL.md", "scripts/fixed.bin") + `?snapshot=${snapshot}`);
    expect(await readFile(selected.record.path, "utf8")).not.toContain(f.content);
    paths.push(selected.record.path);
  }
  expect(new Set(paths).size).toBe(1);
  expect(await readdir(join(f.source.cacheDir!, "scopes", scope, "indexes"))).toHaveLength(1);
  expect((await f.calls()).map(args => args[0])).toEqual(["files", "files"]);
});

test("SC25 a fixed snapshot absent from one source can be found in another without hiding permission failures", async () => {
  const absent = await fixture(), present = await fixture(), input = `skill://shared/SKILL.md?snapshot=${snapshot}`;
  absent.state.files = { ok: false, error: { code: "SNAPSHOT_MISSING" } }; await absent.save();
  const selected = await resolveNotionReference(input, [{ ...absent.source, id: "absent" }, { ...present.source, id: "present" }], present.root);
  expect(selected.record.sourceId).toBe("present");
  await expect(resolveNotionReference(input, [absent.source], absent.root)).rejects.toMatchObject({ code: "SNAPSHOT_MISSING" });
  for (const code of ["AUTH_REQUIRED", "ACCESS_DENIED", "STATE_CORRUPT", "CATALOG_INCOMPLETE"]) {
    absent.state.files = { ok: false, error: { code } }; await absent.save();
    await expect(resolveNotionReference(input, [present.source, absent.source], present.root)).rejects.toMatchObject({ code });
  }
  expect((await absent.calls()).some(args => args[0] !== "files")).toBe(false);
  expect((await present.calls()).some(args => args[0] !== "files")).toBe(false);
});

test("SC25 custom fixed metadata must belong to the configured UUID database", async () => {
  const f = await fixture(), files = f.state.files as Json;
  f.state.files = { ...files, record: { ...f.record, locator: { ...f.record.locator, database_id: uuid(90) } } }; await f.save();
  await expect(resolveNotionReference(`skill://shared/SKILL.md?snapshot=${snapshot}`, [f.source], f.root)).rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
  expect((await f.calls()).map(args => args[0])).toEqual(["files"]);
});

test("SC25 custom fixed database aliases use same-scope metadata without rebinding the historical owner", async () => {
  const f = await fixture(), input = `skill://shared/scripts/fixed.bin?snapshot=${snapshot}`;
  f.state.catalog = listing([]); await f.save();
  const selected = await resolveNotionReference(input, [{ ...f.source, database: "shared", activation: { offline: true } }], f.root);
  expect(selected.record.id).toBe(f.record.id);
  const calls = await f.calls(), lists = calls.filter(args => args[0] === "list");
  expect(lists).toHaveLength(1); expect(lists[0]).toContain("--offline");
  expect(calls.every(args => ["files", "list", "ctl"].includes(args[0]!))).toBe(true);
  await f.clearCalls();
  f.state.files = { ...(f.state.files as Json), scope: "e".repeat(64) }; await f.save();
  await expect(resolveNotionReference(input, [{ ...f.source, database: "shared" }], f.root)).rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
});

test("SC25 current names use the complete ordinary directory outside the default View", async () => {
  const outside = { ...sharedRecord("outside", { page: uuid(51) }), name: "Outside View", alias: "outside" };
  const f = await fixture({ records: [sharedRecord(), outside], profile: true });
  expect((await discoverNotionSource(f.source, f.root, { defaultView: true })).map(record => record.id)).toEqual([f.record.id]);
  for (const selector of [outside.name, outside.alias]) {
    const selected = await resolveNotionReference(`skill://${encodeURIComponent(selector)}/SKILL.md`, [f.source], f.root);
    expect(selected.ref).toBe(outside.ref); expect(selected.record).toMatchObject({ id: outside.id, sourceScope: scope, sourceId: f.source.id });
  }
  const calls = await f.calls(), lists = calls.filter(args => args[0] === "list");
  expect(lists).toHaveLength(2); expect(lists[0]).toContain("--default-view"); expect(lists[1]).not.toContain("--default-view");
  expect(calls.some(args => ["read", "prepare", "use", "export", "files"].includes(args[0]!))).toBe(false);
});

test("SC25 current names wait for every custom page before invoking the shared resolver", async () => {
  const first = { ...sharedRecord("first"), alias: "first" }, second = { ...sharedRecord("second", { page: uuid(52) }), alias: "second" };
  const f = await fixture(), initial = listing([first]);
  f.state.pages = { first: { ...initial, total_count: 2, has_more: true, next_cursor: "page-two" },
    "page-two": { ...initial, records: [second], total_count: 2, has_more: false, next_cursor: null } }; await f.save();
  expect((await resolveNotionReference("skill://second/SKILL.md", [f.source], f.root)).record.id).toBe(second.id);
  const calls = await f.calls(), lists = calls.filter(args => args[0] === "list");
  expect(lists).toHaveLength(2); expect(lists[1].slice(-3)).toEqual(["--offline", "--cursor", "page-two"]);
  expect(calls.some(args => ["read", "prepare", "use", "export", "files"].includes(args[0]!))).toBe(false);
});

test("SC25 a partial or projected current catalog cannot prove a name unique or absent", async () => {
  for (const count of [0, 1]) for (const defect of ["incomplete", "query", "view_query"]) {
    const f = await fixture(), catalog = listing(count ? [f.record] : []);
    f.state.catalog = defect === "incomplete" ? { ...catalog, coverage: { ...(catalog.coverage as Json), exhaustive: false, search_index_limited: true } }
      : { ...catalog, [defect]: "selected-subset" }; await f.save();
    await expect(resolveNotionReference("skill://shared/SKILL.md", [f.source], f.root)).rejects.toMatchObject({ code: "CATALOG_INCOMPLETE" });
    expect((await f.calls()).some(args => ["read", "prepare", "use", "export", "files"].includes(args[0]!))).toBe(false);
  }
});

test("SC25 enabled name ambiguity, cross-source scope and failed authorities remain distinct", async () => {
  const f = await fixture({ records: [sharedRecord(), sharedRecord("other", { page: uuid(53) })] });
  await expect(resolveNotionReference("skill://shared/SKILL.md", [f.source], f.root)).rejects.toMatchObject({ code: "SKILL_AMBIGUOUS" });
  const enabled = await fixture({ records: [sharedRecord(), sharedRecord("disabled", { page: uuid(54), enabled: false })] });
  expect((await resolveNotionReference("skill://shared/SKILL.md", [enabled.source], enabled.root)).record.id).toBe(enabled.record.id);
  const other = await fixture(); other.state.catalog = { ...(other.state.catalog as Json), scope: "f".repeat(64) }; await other.save();
  await expect(resolveNotionReference("skill://shared/SKILL.md", [enabled.source, { ...other.source, id: "other-authority" }], enabled.root)).rejects.toMatchObject({ code: "SKILL_AMBIGUOUS" });
  other.state.catalog = { ok: false, error: { code: "ACCESS_DENIED" } }; await other.save();
  await expect(resolveNotionReference("skill://shared/SKILL.md", [enabled.source, { ...other.source, id: "other-authority" }], enabled.root, { refresh: true })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  const controller = new AbortController(); controller.abort(); await other.clearCalls();
  await expect(resolveNotionReference("skill://shared/SKILL.md", [other.source], other.root, { signal: controller.signal })).rejects.toMatchObject({ code: "SOURCE_CANCELLED" });
  expect(await other.calls()).toEqual([]);
});

async function ambiguityTools(fixtures: readonly { fixture: Awaited<ReturnType<typeof fixture>>; source: NotionSource }[], withUse: boolean) {
  const root = fixtures[0]!.fixture.root, entries: SessionEntry[] = [];
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const tools = new Map<string, Parameters<NonNullable<ExtensionAPI["registerTool"]>>[0]>();
  const native: PiReadDefinition = { name: "read", label: "read", description: "Native fixture reader",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute(_id, input) {
      assert.equal(typeof input.path, "string");
      return { content: [{ type: "text", text: await readFile(input.path, "utf8") }] };
    } };
  tools.set("read", native);
  const api: ExtensionAPI = {
    on(name, listener) { events.set(name, [...events.get(name) ?? [], listener]); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools: () => [...tools.values()].map(tool => ({ ...tool, sourceInfo: { source: tool === native ? "builtin" : "local", path: "/fixture" } })),
    getActiveTools: () => ["read"], appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  const ctx: ExtensionContext = { cwd: root, hasUI: false, mode: "rpc", sessionManager: {
    getSessionId: () => "ambiguity-session", getSessionFile: () => join(root, "session.jsonl"), getBranch: () => entries,
  } };
  const state = { loads: [] as SkillRecord[], preparations: [] as Array<{ records: readonly SkillRecord[]; purpose: string; pins: ReadonlyMap<string, string> | undefined }> };
  const host = await installHostSkills(api, {
    config: { sources: fixtures.map(value => value.source) }, getRecords: async () => ({ records: [], failures: [] }),
    resolveNamedReference: (ref, _ctx, signal, refresh) => resolveNotionReference(ref, fixtures.map(value => value.source), root, { signal, refresh }),
    loadRecord: async (record, signal, snapshotId) => {
      state.loads.push(record);
      const selected = fixtures.find(value => value.source.id === record.sourceId);
      assert.ok(selected);
      return loadNotionSkill(record, selected.source, root, { signal, snapshotId });
    },
    ...(withUse ? { prepareGraph: async (records: readonly SkillRecord[], _ctx: ExtensionContext | undefined, _signal: AbortSignal | undefined, purpose: "use" | "inspect", pins?: ReadonlyMap<string, string>) => {
      state.preparations.push({ records, purpose, pins });
      throw Object.assign(new Error("Reached exact preparation boundary"), { code: "CONTROLLED_PREPARATION" });
    } } : {}),
  }, createPiHostAdapter(api, async () => () => native));
  const emit = async (name: string) => { for (const listener of events.get(name) ?? []) await listener({ type: name } as never, ctx); };
  await emit("session_start"); await host.refresh(ctx);
  return { state, entries, emit, call: (name: "read" | "notion_use", ref: string) => {
    const tool = tools.get(name); assert.ok(tool);
    return tool.execute("ambiguity-" + name, name === "read" ? { path: ref } : { ref }, undefined, undefined, ctx);
  } };
}

async function ambiguityOutput(operation: Promise<unknown>) {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  assert.ok(failure instanceof Error, "The registered tool must reject the ambiguous reference");
  expect(failure.message).toContain("SKILL_AMBIGUOUS");
  expect(failure.message).toContain('"candidates"');
  const value: unknown = JSON.parse(failure.message);
  assert.ok(value && typeof value === "object" && "candidates" in value && Array.isArray(value.candidates));
  return value.candidates.map((candidate: unknown) => {
    assert.ok(candidate && typeof candidate === "object" && "name" in candidate && typeof candidate.name === "string"
      && "source" in candidate && typeof candidate.source === "string" && "ref" in candidate && typeof candidate.ref === "string");
    return { name: candidate.name, source: candidate.source, ref: candidate.ref,
      selectable: !("selectable" in candidate) || candidate.selectable !== false };
  });
}

test.each(["read", "notion_use"] as const)("SC04 registered %s returns copyable same-source choices without body preparation", async tool => {
  const first = sharedRecord(), second = sharedRecord("second", { page: uuid(61) });
  const f = await fixture({ records: [first, second] }), h = await ambiguityTools([{ fixture: f, source: f.source }], tool === "notion_use");
  try {
    const choices = await ambiguityOutput(h.call(tool, "skill://shared/SKILL.md"));
    expect(choices.map(choice => [choice.name, choice.source])).toEqual([[first.name, "shared"], [second.name, "shared"]]);
    expect(choices.every(choice => /^sr:C[A-Za-z0-9_-]{22}$/.test(choice.ref) && choice.selectable)).toBe(true);
    expect(h.state.loads).toEqual([]); expect(h.state.preparations).toEqual([]);
    expect((await f.calls()).filter(args => args[0] === "list")).toHaveLength(1);
    expect((await f.calls()).some(args => ["read", "prepare", "files", "export"].includes(args[0]!))).toBe(false);
    const selected = choices[0]!;
    if (tool === "read") {
      const result = await h.call(tool, selected.ref);
      expect(result.content).toEqual([{ type: "text", text: f.content }]);
      expect(h.state.loads.map(record => [record.id, record.sourceId, record.sourceScope])).toEqual([[first.id, "shared", scope]]);
      expect(h.state.preparations).toEqual([]);
    } else {
      await expect(h.call(tool, selected.ref)).rejects.toMatchObject({ code: "CONTROLLED_PREPARATION" });
      expect(h.state.preparations.map(value => [value.purpose, value.records[0]?.id, value.records[0]?.sourceScope])).toEqual([["use", first.id, scope]]);
      expect(h.state.loads).toEqual([]);
    }
    expect((await f.calls()).filter(args => args[0] === "list")).toHaveLength(1);
  } finally { await h.emit("session_shutdown"); }
});

test.each(["read", "notion_use"] as const)("SC04 registered %s keeps equal IDs in different scopes independently selectable", async tool => {
  const first = await fixture(), second = await fixture(), otherScope = "e".repeat(64);
  second.state.catalog = { ...(second.state.catalog as Json), scope: otherScope };
  second.state.read = { ...second.read, scope: otherScope };
  await second.save();
  const h = await ambiguityTools([{ fixture: first, source: first.source }, { fixture: second, source: { ...second.source, id: "other-scope" } }], tool === "notion_use");
  try {
    const choices = await ambiguityOutput(h.call(tool, "skill://shared/SKILL.md"));
    expect(choices.map(choice => choice.source)).toEqual(["shared", "other-scope"]);
    expect(new Set(choices.map(choice => choice.ref)).size).toBe(2);
    expect(h.state.loads).toEqual([]); expect(h.state.preparations).toEqual([]);
    if (tool === "read") {
      expect((await h.call(tool, choices[1]!.ref)).content).toEqual([{ type: "text", text: second.content }]);
      expect(h.state.loads.map(record => [record.sourceId, record.sourceScope])).toEqual([["other-scope", otherScope]]);
    } else {
      await expect(h.call(tool, choices[1]!.ref)).rejects.toMatchObject({ code: "CONTROLLED_PREPARATION" });
      expect(h.state.preparations.map(value => [value.records[0]?.sourceId, value.records[0]?.sourceScope])).toEqual([["other-scope", otherScope]]);
    }
    expect((await first.calls()).filter(args => args[0] === "list")).toHaveLength(1);
    expect((await second.calls()).filter(args => args[0] === "list")).toHaveLength(1);
  } finally { await h.emit("session_shutdown"); }
});

test.each(["read", "notion_use"] as const)("SC04 registered %s keeps fixed choices pinned and selects a distinct historical owner", async tool => {
  const first = await fixture(), other = sharedRecord("historical-other", { page: uuid(62) }), second = await fixture();
  second.state.files = { ...(second.state.files as Json), record: other, ref: other.ref + "?snapshot=" + snapshot,
    files: [{ path: other.entrypoint, bytes: Buffer.byteLength(second.content), ref: other.ref + "?snapshot=" + snapshot }] };
  await second.save();
  const h = await ambiguityTools([{ fixture: first, source: first.source }, { fixture: second, source: { ...second.source, id: "historical-other" } }], tool === "notion_use");
  try {
    const choices = await ambiguityOutput(h.call(tool, "skill://shared/SKILL.md?snapshot=" + snapshot));
    expect(choices.map(choice => choice.ref)).toEqual([first.read.ref, other.ref + "?snapshot=" + snapshot]);
    expect(choices.every(choice => choice.selectable)).toBe(true);
    expect(h.entries).toEqual([]); expect(h.state.loads).toEqual([]); expect(h.state.preparations).toEqual([]);
    expect((await first.calls()).filter(args => args[0] === "files")).toHaveLength(1);
    expect((await second.calls()).filter(args => args[0] === "files")).toHaveLength(1);
    if (tool === "read") {
      expect((await h.call(tool, choices[0]!.ref)).content).toEqual([{ type: "text", text: first.content }]);
      expect(h.state.loads.map(record => [record.id, record.sourceScope, record.snapshotId])).toEqual([[first.record.id, scope, snapshot]]);
    } else {
      await expect(h.call(tool, choices[0]!.ref)).rejects.toMatchObject({ code: "CONTROLLED_PREPARATION" });
      expect([...h.state.preparations[0]!.pins!]).toEqual([[first.record.id, snapshot]]);
    }
    expect((await first.calls()).some(args => args[0] === "list")).toBe(false);
    expect((await second.calls()).some(args => args[0] === "list")).toBe(false);
  } finally { await h.emit("session_shutdown"); }
});

test("SC04 equal fixed refs in different scopes remain explicitly non-selectable without inventing a preparation proof", async () => {
  const first = await fixture(), second = await fixture();
  second.state.files = { ...(second.state.files as Json), scope: "e".repeat(64) }; await second.save();
  const h = await ambiguityTools([{ fixture: first, source: first.source }, { fixture: second, source: { ...second.source, id: "other-scope" } }], false);
  try {
    const choices = await ambiguityOutput(h.call("read", "skill://shared/SKILL.md?snapshot=" + snapshot));
    expect(choices).toEqual([
      { name: first.record.name, source: "shared", ref: first.read.ref, selectable: false },
      { name: second.record.name, source: "other-scope", ref: second.read.ref, selectable: false },
    ]);
    expect(h.entries).toEqual([]); expect(h.state.loads).toEqual([]); expect(h.state.preparations).toEqual([]);
    expect((await first.calls()).some(args => ["list", "read", "prepare", "export"].includes(args[0]!))).toBe(false);
    expect((await second.calls()).some(args => ["list", "read", "prepare", "export"].includes(args[0]!))).toBe(false);
  } finally { await h.emit("session_shutdown"); }
});

test("SC04 resource ambiguity preserves the requested path instead of offering a main-entry handle", async () => {
  const f = await fixture({ records: [sharedRecord(), sharedRecord("second", { page: uuid(63) })] });
  const h = await ambiguityTools([{ fixture: f, source: f.source }], false);
  try {
    const choices = await ambiguityOutput(h.call("read", "skill://shared/references/exact%2520name.md"));
    expect(choices.every(choice => choice.ref.endsWith("/references/exact%2520name.md") && choice.selectable)).toBe(true);
    expect(h.entries).toEqual([]); expect(h.state.loads).toEqual([]);
    expect((await f.calls()).some(args => ["read", "files", "prepare", "export"].includes(args[0]!))).toBe(false);
  } finally { await h.emit("session_shutdown"); }
});

test.each(["read", "notion_use"] as const)("SC04 registered %s does not hide a failed authority behind another source's ambiguity", async tool => {
  const first = await fixture({ records: [sharedRecord(), sharedRecord("second", { page: uuid(64) })] }), failed = await fixture();
  failed.state.catalog = { ok: false, error: { code: "ACCESS_DENIED", details: { token: "PRIVATE_TOKEN", path: "/private/credentials", candidates: [failed.record] } } };
  await failed.save();
  const h = await ambiguityTools([{ fixture: first, source: first.source }, { fixture: failed, source: { ...failed.source, id: "denied" } }], tool === "notion_use");
  try {
    let failure: unknown; try { await h.call(tool, "skill://shared/SKILL.md"); } catch (error) { failure = error; }
    assert.ok(failure instanceof Error); expect(failure.message).toContain("ACCESS_DENIED");
    for (const privateValue of ['"candidates"', "PRIVATE_TOKEN", "/private/credentials", "sr:C"]) expect(failure.message).not.toContain(privateValue);
    expect(h.entries).toEqual([]); expect(h.state.loads).toEqual([]); expect(h.state.preparations).toEqual([]);
  } finally { await h.emit("session_shutdown"); }
});

const invalidRecords: [string, (record: ContentRecord) => unknown][] = [
  ["missing Enabled", ({ enabled: _enabled, ...record }) => record],
  ["nonboolean Enabled", record => ({ ...record, enabled: "true" })],
  ["unknown content field", record => ({ ...record, ownership: "custom" })],
  ["unknown locator field", record => ({ ...record, locator: { ...record.locator, token: "not-a-wire-field" } })],
  ["old page identity", record => ({ ...record, id: `notion_page:${page}` })],
  ["unescaped shared ref", record => ({ ...record, ref: "skill://shared_skill%3Alib%3Ateam%3Askill%3Aone/SKILL.md" })],
  ["invalid library identity", record => ({ ...record, locator: { ...record.locator, library_id: "lib/team" } })],
  ["overlong skill identity", record => ({ ...record, locator: { ...record.locator, skill_id: "a".repeat(201) } })],
  ["noncanonical page", record => ({ ...record, locator: { ...record.locator, page_id: page.replaceAll("-", "") } })],
  ["wrong data source", record => ({ ...record, locator: { ...record.locator, data_source_id: uuid(99) } })],
  ["wrong entrypoint", record => ({ ...record, entrypoint: "PROMPT.md" })],
  ["upstream field on shared", record => ({ ...record, upstream: { repo: "unexpected" } })],
];
test.each(invalidRecords)("shared wire rejects %s", async (_name, change) => {
  const f = await fixture({ records: [change(sharedRecord())] });
  await assert.rejects(discoverNotionSource(f.source, f.root), { code: "SOURCE_RESPONSE_INVALID" });
});

test("disabled shared rows are excluded, but duplicate stable identities still reject", async () => {
  const f = await fixture({ records: [sharedRecord(), sharedRecord("disabled", { page: uuid(6), enabled: false })] });
  expect((await discoverNotionSource(f.source, f.root)).map(record => record.id)).toEqual([sharedRecord().id]);
  f.state.catalog = listing([sharedRecord(), sharedRecord("skill:one", { page: uuid(6), enabled: false })]);
  await f.save();
  await assert.rejects(discoverNotionSource(f.source, f.root, { refresh: true }), { code: "SOURCE_RESPONSE_INVALID" });
});

test("legacy Notion page records retain their existing optional Enabled contract", async () => {
  const record: ContentRecord = { id: `notion_page:${page}`, kind: "skill", locator: { type: "notion_page", page_id: page, database_id: database, data_source_id: dataSource }, name: "Legacy", alias: "legacy", description: "Legacy record", default_context: false, entrypoint: "SKILL.md", ref: `skill://${page}/SKILL.md` };
  const f = await fixture({ records: [record] });
  expect((await discoverNotionSource(f.source, f.root))[0]?.id).toBe(record.id);
});

test("one physical shared page cannot claim two logical Skill identities", async () => {
  const f = await fixture({ records: [sharedRecord(), sharedRecord("second-identity")] });
  await assert.rejects(discoverNotionSource(f.source, f.root), { code: "SOURCE_RESPONSE_INVALID" });
  expect((await f.calls()).some(args => ["read", "export"].includes(args[0]!))).toBe(false);
});

test("selected shared records retain Enabled through read and exact snapshot export", async () => {
  const f = await fixture(), selected = (await discoverNotionSource(f.source, f.root))[0]!;
  const loaded = await loadNotionSkill(selected, f.source, f.root);
  expect(loaded.enabled).toBe(true);
  expect(loaded.locator).toEqual(f.record.locator);
  expect(loaded.body).toBe(f.content);
  expect(new Uint8Array(await readFile(join(dirname(loaded.path), "scripts/fixed.bin")))).toEqual(new Uint8Array([0, 255, 13, 10]));
  expect((await f.calls()).filter(args => args[0] === "export")).toHaveLength(1);
});

test("new native snapshots retain stable main and resource File bindings through public read/export", async () => {
  const f = await fixture();
  const fileBindings = [
    { file_id: "main-id", page_id: page, path: "SKILL.md" },
    { file_id: "resource-id", page_id: uuid(41), path: "scripts/fixed.bin" },
  ];
  f.state.read = { ...f.read, ref: f.read.ref + "&file_id=main-id", file_bindings: fileBindings };
  await f.save();
  const selected = (await discoverNotionSource(f.source, f.root))[0]!;
  const loaded = await loadNotionSkill(selected, f.source, f.root);
  expect(loaded.snapshotId).toBe(snapshot);
  expect(loaded.body).toBe(f.content);
  expect(loaded).toHaveProperty("fileBindings", fileBindings);
  const pinned = await loadNotionSkill(selected, f.source, f.root, { snapshotId: snapshot });
  expect(pinned).toHaveProperty("fileBindings", fileBindings);
});

test("a shared selected-page miss uses the physical page UUID; a missing resource stays a source error", async () => {
  const f = await fixture();
  f.state.read = { ok: false, error: { code: "NOT_FOUND", details: { notion_code: "object_not_found", path: `v1/pages/${page}` } } };
  await f.save();
  await assert.rejects(loadNotionSkill(hostRecord(), f.source, f.root), ReferenceMiss);
  f.state.read = { ok: false, error: { code: "NOT_FOUND", details: { notion_code: "object_not_found", path: `v1/pages/${uuid(9)}` } } };
  await f.save();
  await assert.rejects(loadNotionSkill(hostRecord(), f.source, f.root), { code: "NOT_FOUND" });
});

test("disabled selected or newly disabled shared records never export a body", async () => {
  const f = await fixture();
  await assert.rejects(loadNotionSkill(hostRecord(sharedRecord("skill:one", { enabled: false })), f.source, f.root), { code: "CONTENT_DISABLED" });
  expect(await f.calls()).toEqual([]);
  f.state.read = { ...f.read, record: { ...f.record, enabled: false } };
  await f.save();
  await assert.rejects(loadNotionSkill(hostRecord(), f.source, f.root), { code: "CONTENT_DISABLED" });
  expect((await f.calls()).map(args => args[0])).toEqual(["read"]);
});

test("shared selection tokens, diagnostics and catalog refs use exact physical and logical identities", () => {
  const record = hostRecord(), precise = `shared@${page.replaceAll("-", "")}@team`;
  expect(preciseRecordToken(record)).toBe(precise);
  expect(matchesPreciseRecordToken(precise, record)).toBe(true);
  expect(formatFindDiagnostics("shared", [record])).toContain(page);
  const reference = parseCatalogMember({ type: "remote", source: { namespace: "team" }, id: record.id, locator: record.locator, ref: record.ref });
  assert.equal(reference.type, "remote");
  if (reference.type !== "remote") throw new Error("Expected the declared remote member");
  const context = { sources: [{ type: "notion", id: "shared", namespace: "team" } satisfies NotionSource], records: [record] };
  expect(resolveCatalogReference(reference, context, "skill")).toBe(record);
  assert.throws(() => resolveCatalogReference(reference, { ...context, records: [{ ...record, enabled: false }] }, "skill"), { code: "CATALOG_MEMBER_UNAVAILABLE" });
  assert.throws(() => resolveCatalogReference(reference, { ...context, records: [hostRecord(sharedRecord("skill:one", { page: uuid(11) }))] }, "skill"), { code: "SOURCE_IDENTITY_MISMATCH" });
  assert.throws(() => parseCatalogMember({ ...reference, ref: `skill://${page}/SKILL.md` }));
  assert.throws(() => parseCatalogMember({ ...reference, locator: { ...reference.locator, private_path: "/untrusted" } }));
});

test("Profile configuration requires an explicit database and a bounded stable profile id", () => {
  expect(normalizeSources([{ type: "notion", id: "shared", database, profile_id: "work" }])?.[0]).toMatchObject({ profile_id: "work", database });
  for (const raw of [{ type: "notion", id: "shared", profile_id: "work" }, { type: "notion", id: "shared", database, profile_id: "../work" }, { type: "notion", id: "shared", database, profile_id: "x".repeat(201) }]) assert.throws(() => normalizeSources([raw]), { code: "SOURCE_CONFIG_INVALID" });
});

test("Profile-selected directories never enter the full-catalog cache", async () => {
  const other = sharedRecord("other", { page: uuid(6) });
  const f = await fixture({ records: [sharedRecord(), other], profile: true });
  const full = await discoverNotionSource(f.source, f.root);
  expect(full).toHaveLength(2);
  expect((await f.calls()).filter(args => args[0] === "list")[0]).not.toContain("--profile");
  await f.clearCalls();
  const selected = await discoverNotionSource(f.source, f.root, { defaultView: true });
  expect(selected).toHaveLength(1);
  expect(await f.calls()).toEqual([["list", "--database", database, "--default-view", "--profile", "work"]]);
  await f.clearCalls();
  expect(await discoverNotionSource(f.source, f.root)).toHaveLength(2);
  expect((await f.calls()).some(args => args[0] === "list")).toBe(false);
});

test("session View remains explicit over configured Profile, without a hidden default-context filter", async () => {
  const other = sharedRecord("other", { page: uuid(6) });
  const f = await fixture({ records: [sharedRecord(), other], profile: true });
  f.state.explicit = listing([other], "view");
  await f.save();
  const catalog = { records: await discoverNotionSource(f.source, f.root), failures: [] };
  const selected = await resolveViewDiscovery({ sources: [f.source] }, catalog, { cwd: f.root });
  expect(selected.views?.[0]).toMatchObject({ origin: "profile", status: "ready" });
  expect(selected.records.filter(record => record.defaultDiscovery).map(record => record.id)).toEqual([sharedRecord().id]);
  await f.clearCalls();
  const ctx: ExtensionContext = { cwd: f.root, sessionManager: { getBranch: () => [{ type: "custom", customType: VIEW_SELECTION_ENTRY, data: { version: 1, sourceId: f.source.id, viewId: view } }] } };
  const explicit = await resolveViewDiscovery({ sources: [f.source] }, catalog, ctx);
  expect(explicit.views?.[0]).toMatchObject({ origin: "session", status: "ready" });
  expect(explicit.records.filter(record => record.defaultDiscovery).map(record => record.id)).toEqual([other.id]);
  expect(await f.calls()).toEqual([["list", "--database", database, "--view", view]]);
});

test("a Profile error remains a failed default directory without unfiltered fallback", async () => {
  const f = await fixture({ profile: true });
  f.state.profile = { ok: false, error: { code: "SHARED_PROFILE_NOT_FOUND" } };
  await f.save();
  const result = await resolveViewDiscovery({ sources: [f.source] }, { records: [hostRecord()], failures: [] }, { cwd: f.root });
  expect(result.views?.[0]).toEqual({ sourceId: "shared", origin: "profile", status: "error", code: "SHARED_PROFILE_NOT_FOUND" });
  expect(result.records.some(record => record.defaultDiscovery)).toBe(false);
  expect(await f.calls()).toEqual([["list", "--database", database, "--default-view", "--profile", "work"]]);
});

test("the CLI's machine-bound Profile reports its actual origin without a Broker Profile override", async () => {
  const f = await fixture();
  const catalog = { records: await discoverNotionSource(f.source, f.root), failures: [] };
  await f.clearCalls();
  const selected = await resolveViewDiscovery({ sources: [f.source] }, catalog, { cwd: f.root });
  expect(selected.views?.[0]).toMatchObject({ origin: "profile", status: "ready" });
  expect(await f.calls()).toEqual([["list", "--database", database, "--default-view"]]);
});

test("wrong Profile scope or unsolicited filtered full-catalog receipts are rejected", async () => {
  const f = await fixture({ profile: true });
  const selected = listing([sharedRecord()], "profile");
  f.state.profile = { ...selected, profile: { ...(selected.profile as Json), library_id: "other-library" } };
  await f.save();
  await assert.rejects(discoverNotionSource(f.source, f.root, { defaultView: true }), { code: "SOURCE_RESPONSE_INVALID" });
  f.state.catalog = selected;
  await f.save();
  await assert.rejects(discoverNotionSource(f.source, f.root), { code: "SOURCE_RESPONSE_INVALID" });
});

test("a View cannot apply stable-id membership to a different cached physical page", async () => {
  const other = sharedRecord("other", { page: uuid(6) });
  const f = await fixture({ records: [sharedRecord(), other] });
  f.state.explicit = listing([sharedRecord(), sharedRecord("other", { page: uuid(7) })], "view");
  await f.save();
  const catalog = { records: await discoverNotionSource(f.source, f.root), failures: [] };
  const result = await resolveViewDiscovery({ sources: [{ ...f.source, default_view_id: view }] }, catalog, { cwd: f.root });
  expect(result.views?.[0]).toMatchObject({ status: "error", code: "SOURCE_IDENTITY_MISMATCH" });
  expect(result.records.some(record => record.defaultDiscovery)).toBe(false);
});

test("the selected View itself must belong to the returned database and queried data source", async () => {
  const f = await fixture({ profile: true });
  const selected = listing([sharedRecord()], "profile");
  f.state.profile = { ...selected, view: { ...(selected.view as Json), data_source_id: uuid(99) } };
  await f.save();
  const result = await resolveViewDiscovery({ sources: [f.source] }, { records: [hostRecord()], failures: [] }, { cwd: f.root });
  expect(result.views?.[0]).toMatchObject({ status: "error", code: "SOURCE_RESPONSE_INVALID" });
  expect(result.records.some(record => record.defaultDiscovery)).toBe(false);
});

async function observeWrite(result: Json, operation = "update", args: readonly string[] = []) {
  const handlers = new Map<string, unknown>(), changed: string[][] = [];
  const api: ExtensionAPI = { on(event, handler) { handlers.set(event, handler); } };
  const source: NotionSource = { type: "notion", id: "shared", namespace: "team", command: ["node", "ntn-skills.mjs"], database };
  installCliWriteInvalidation(api, { sources: [source], records: () => [hostRecord()], changed(ids) { changed.push(ids); } });
  const context: ExtensionContext = { sessionManager: { getSessionId: () => "controlled-session" } };
  const call = handlers.get("tool_call"), finish = handlers.get("tool_result");
  if (typeof call !== "function" || typeof finish !== "function") throw new Error("Expected installed write-observer handlers");
  const quoted = (argument: string) => "'" + argument.replaceAll("'", "'\\''") + "'";
  const input = { command: [...hostCliScope([source]).command, operation, sharedRecord().ref, ...args, "--database", database].map(quoted).join(" ") };
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

test.each([true, false])("verified shared Enabled=%s updates refresh discovery while preserving receipt checks", async enabled => {
  const receipt = { ...metadataReceipt(), changed_fields: ["Enabled"], record: { ...sharedRecord(), enabled } };
  const args = ["--enabled", String(enabled)];
  expect(await observeWrite(receipt, "update", args)).toEqual([["shared"]]);
  for (const invalid of [
    { ...receipt, verified: false },
    { ...receipt, dry_run: true },
    { ...receipt, status: "unchanged", changed_fields: [] },
    { ...receipt, status: "unknown" },
    { ...receipt, changed_fields: ["Enabled", "Unexpected"] },
    { ...receipt, record: { ...sharedRecord(), enabled: String(enabled) } },
  ]) expect(await observeWrite(invalid, "update", args)).toEqual([]);
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

type ModelObserverRequest = { path: string; content: string; isError?: boolean };
async function modelObserverFixture(options: {
  record?: unknown;
  tamperedResource?: string;
  extraFile?: boolean;
  advertiseEntry?: boolean;
  changeAfterFirstRead?: "scope" | "snapshot" | "missing-receipt" | "resource-bytes";
  requests?: (paths: { entry: string; resource: string; directory: string; body: string; resourceBody: string; advertisedEntry: string; advertisedResource: string }) => ModelObserverRequest[];
} = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "broker-shared-model-observer-"));
  // Run the existing observer in its own Node process, retaining these real files
  // for review and avoiding a global fetch replacement in the Bun test runner.
  const cache = join(root, "cache"), output = join(root, "observations.jsonl");
  const record = sharedRecord(), digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
  if (record.locator.type !== "shared_skill") throw new Error("Expected shared test record");
  const directory = join(cache, "scopes", scope, "records", digest(record.id), "snapshots", snapshot);
  const body = "# Shared model body\nRead references/fixed.md for the exact result.\n";
  const resourceBody = "The fixed shared resource contains result 47.\n";
  const manifest = JSON.stringify({ format: "ntn-skills", version: 2, kind: "skill", main: "SKILL.md", name: record.name, description: record.description });
  const files = [{ path: "SKILL.md", body }, { path: "references/fixed.md", body: resourceBody }, { path: ".ntn-skills.json", body: manifest }];
  for (const file of files) {
    await mkdir(dirname(join(directory, file.path)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, file.path), file.body, { mode: 0o600 });
  }
  const receipt = { version: 3, projection: "snapshot", scope, record: options.record ?? record, snapshot, notionVersion: "verified-current-version", contentId: "d".repeat(64), entry: "SKILL.md",
    files: files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.body), hash: digest(file.body) })) };
  await writeFile(join(directory, ".broker-snapshot.json"), JSON.stringify(receipt), { mode: 0o600 });
  await writeFile(output, "", { mode: 0o600 });
  if (options.tamperedResource !== undefined) await writeFile(join(directory, "references/fixed.md"), options.tamperedResource, { mode: 0o600 });
  if (options.extraFile) await writeFile(join(directory, "undeclared.txt"), "not in the complete manifest", { mode: 0o600 });
  const entry = `${record.ref}?snapshot=${snapshot}`;
  const resource = record.ref.replace(/\/SKILL\.md$/, "/references/fixed.md") + `?snapshot=${snapshot}`;
  const advertisedEntry = join(root, "host", "skills", record.alias, "SKILL.md");
  const advertisedResource = join(dirname(advertisedEntry), "references/fixed.md");
  await mkdir(dirname(advertisedEntry), { recursive: true, mode: 0o700 });
  await writeFile(advertisedEntry, "# Metadata only\n", { mode: 0o600 });
  // No host resource file exists: only the native wrapper can resolve this alias.
  const requests = options.requests?.({ entry, resource, directory, body, resourceBody, advertisedEntry, advertisedResource })
    ?? [{ path: options.advertiseEntry ? advertisedEntry : entry, content: body }, { path: options.advertiseEntry ? advertisedResource : resource, content: resourceBody }];
  const settings = { model: "controlled/observer", provider: "controlled", id: "observer", marker: "Shared model body", alias: record.alias,
    selected: { selector: record.id, physicalSelector: record.locator.page_id, locator: record.locator, id: record.id, kind: record.kind, entry: record.entrypoint, ref: record.ref },
    cache, cwd: root, output };
  const runner = `
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { observe } from ${JSON.stringify(import.meta.resolve("../../../scripts/notion-integration-model.mjs"))};
const handlers=new Map(),decisions=[];
observe({on(name,handler){handlers.set(name,handler)}},{...${JSON.stringify(settings)},fs,crypto,path});
if(${Boolean(options.advertiseEntry)})handlers.get('before_agent_start')({systemPrompt:${JSON.stringify(`<skill><name>${record.alias}</name><location>${advertisedEntry}</location></skill>`)}},{model:{provider:'controlled',id:'observer'}});
for(const [index,request] of ${JSON.stringify(requests)}.entries()){
 const event={toolName:'read',toolCallId:'controlled-'+index,input:{path:request.path}};
 const decision=handlers.get('tool_call')(event);
 decisions.push(decision??{allowed:true});
 if(!decision?.block)handlers.get('tool_result')({...event,isError:request.isError??false,content:[{type:'text',text:request.content}]});
 if(index===0){
  const change=${JSON.stringify(options.changeAfterFirstRead ?? null)},directory=${JSON.stringify(directory)},receiptPath=path.join(directory,'.broker-snapshot.json');
  if(change==='scope'||change==='snapshot'){
   const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
   receipt[change]=change==='scope'?'f'.repeat(64):'s_'+'f'.repeat(64);
   const next=path.join(${JSON.stringify(cache)},'scopes',receipt.scope,'records',${JSON.stringify(digest(record.id))},'snapshots',receipt.snapshot);
   fs.mkdirSync(path.dirname(next),{recursive:true,mode:0o700});fs.renameSync(directory,next);
   fs.writeFileSync(path.join(next,'.broker-snapshot.json'),JSON.stringify(receipt),{mode:0o600});
  }else if(change==='missing-receipt')fs.renameSync(receiptPath,${JSON.stringify(join(root, "retained-original-receipt.json"))});
  else if(change==='resource-bytes'){
   const resource=path.join(directory,'references/fixed.md');fs.renameSync(resource,${JSON.stringify(join(root, "retained-original-resource.md"))});
   fs.writeFileSync(resource,'Changed after entry validation',{mode:0o600});
  }
 }
}
process.stdout.write(JSON.stringify({decisions,events:fs.readFileSync(${JSON.stringify(output)},'utf8').split('\\n').filter(Boolean).map(JSON.parse)}));
`;
  const result: unknown = JSON.parse(execFileSync(node, ["--input-type=module", "-e", runner], { encoding: "utf8" }));
  assert.ok(result !== null && typeof result === "object" && "decisions" in result && "events" in result);
  assert.ok(Array.isArray(result.decisions) && Array.isArray(result.events));
  return { decisions: result.decisions as Json[], events: result.events as Json[] };
}

test("the existing model observer validates canonical shared refs and actual complete entry/resource bytes", async () => {
  const observed = await modelObserverFixture();
  expect(observed.decisions).toEqual([{ allowed: true }, { allowed: true }]);
  expect(observed.events.filter(event => event.phase === "tool_result")).toMatchObject([
    { kind: "skill", role: "entrypoint", recordId: sharedRecord().id, receiptValidated: true, bodyMatchesFile: true, resourceSuccess: false },
    { kind: "resource", role: "resource", recordId: sharedRecord().id, receiptValidated: true, bodyMatchesFile: true, resourceSuccess: true },
  ]);
  expect(observed.events.some(event => ["transport", "request", "response", "assistant_final"].includes(String(event.phase)))).toBe(false);
});

test("the model observer accepts an advertised resource alias before OMP rewrites it only after a verified entry read", async () => {
  const observed = await modelObserverFixture({ advertiseEntry: true });
  expect(observed.decisions).toEqual([{ allowed: true }, { allowed: true }]);
  expect(observed.events.filter(event => event.phase === "tool_result")).toMatchObject([
    { kind: "skill", requestedRole: "index", scope, snapshot, receiptValidated: true, bodyMatchesFile: true },
    { kind: "resource", role: "resource", scope, snapshot, entry: "references/fixed.md", receiptValidated: true, bodyMatchesFile: true, resourceSuccess: true },
  ]);
  expect(observed.events.some(event => ["transport", "request", "response", "assistant_final"].includes(String(event.phase)))).toBe(false);
});

test("advertised directories do not authorize early, traversing, undeclared or unrelated resource paths", async () => {
  const observed = await modelObserverFixture({ advertiseEntry: true, requests: ({ advertisedEntry, advertisedResource, body, resourceBody }) => [
    { path: advertisedResource, content: resourceBody },
    { path: advertisedEntry, content: body },
    { path: dirname(advertisedEntry) + "/references/../references/fixed.md", content: resourceBody },
    { path: dirname(advertisedEntry) + "/references/undeclared.md", content: resourceBody },
    { path: dirname(advertisedEntry) + "-other/references/fixed.md", content: resourceBody },
    { path: advertisedResource, content: resourceBody },
  ] });
  expect(observed.decisions.map(decision => decision.block === true)).toEqual([true, false, true, true, true, false]);
  expect(observed.events.filter(event => event.phase === "tool_result" && event.resourceSuccess)).toHaveLength(1);
  const unadvertised = await modelObserverFixture({ requests: ({ entry, advertisedResource, body, resourceBody }) => [
    { path: entry, content: body }, { path: advertisedResource, content: resourceBody },
  ] });
  expect(unadvertised.decisions.map(decision => decision.block === true)).toEqual([false, true]);
});

test("an advertised alias cannot switch active scope or snapshot or survive a missing receipt or changed resource bytes", async () => {
  for (const changeAfterFirstRead of ["scope", "snapshot", "missing-receipt", "resource-bytes"] as const) {
    const observed = await modelObserverFixture({ advertiseEntry: true, changeAfterFirstRead });
    expect(observed.decisions.map(decision => decision.block === true)).toEqual([false, true]);
    expect(observed.events.filter(event => event.phase === "tool_result")).toHaveLength(1);
    expect(observed.events.some(event => event.resourceSuccess)).toBe(false);
  }
});

test("an alias match does not excuse incomplete entry or resource results", async () => {
  const entry = await modelObserverFixture({ advertiseEntry: true, requests: ({ advertisedEntry, advertisedResource, resourceBody }) => [
    { path: advertisedEntry, content: "Shared model body" }, { path: advertisedResource, content: resourceBody },
  ] });
  expect(entry.decisions.map(decision => decision.block === true)).toEqual([false, true]);
  const resource = await modelObserverFixture({ advertiseEntry: true, requests: ({ advertisedEntry, advertisedResource, body }) => [
    { path: advertisedEntry, content: body }, { path: advertisedResource, content: "Changed result 48." },
  ] });
  expect(resource.decisions).toEqual([{ allowed: true }, { allowed: true }]);
  expect(resource.events.filter(event => event.phase === "tool_result")[1]).toMatchObject({ receiptValidated: true, bodyMatchesFile: false, resourceSuccess: false });
});

const invalidModelRecords: [string, (record: ContentRecord) => unknown][] = [
  ["missing shared Enabled", ({ enabled: _enabled, ...record }) => record],
  ["disabled shared record", record => ({ ...record, enabled: false })],
  ["different physical page", record => ({ ...record, locator: { ...record.locator, page_id: uuid(99) } })],
  ["different library identity", record => ({ ...record, locator: { ...record.locator, library_id: "foreign" } })],
  ["legacy identity substitution", record => ({ ...record, id: `notion_page:${page}` })],
  ["noncanonical shared ref", record => ({ ...record, ref: "skill://shared_skill%3Alib%3Ateam%3Askill%3Aone/SKILL.md" })],
  ["unknown receipt field", record => ({ ...record, ownership: "custom" })],
];
test.each(invalidModelRecords)("the model observer refuses receipt-backed reads for %s", async (_name, change) => {
  const observed = await modelObserverFixture({ record: change(sharedRecord()) });
  expect(observed.decisions.every(decision => decision.block === true)).toBe(true);
  expect(observed.events.some(event => event.phase === "tool_result")).toBe(false);
});

test("shared model reads retain the existing snapshot pin and canonical ref boundaries", async () => {
  const observed = await modelObserverFixture({ requests: ({ entry, body, resource, resourceBody }) => [
    { path: entry, content: body },
    { path: resource.replace(snapshot, `s_${"f".repeat(64)}`), content: resourceBody },
    { path: "skill://shared_skill%3Alib%3Ateam%3Askill%3Aone/references/fixed.md", content: resourceBody },
    { path: "skill://" + encodeURIComponent("shared_skill:foreign:skill%3Aone") + "/references/fixed.md", content: resourceBody },
  ] });
  expect(observed.decisions.map(decision => decision.block === true)).toEqual([false, true, true, true]);
  expect(observed.events.filter(event => event.phase === "tool_result")).toHaveLength(1);
});

test("shared model receipts never excuse changed bytes or undeclared snapshot files", async () => {
  for (const options of [{ tamperedResource: "changed after the receipt" }, { extraFile: true }]) {
    const observed = await modelObserverFixture(options);
    expect(observed.decisions.every(decision => decision.block === true)).toBe(true);
    expect(observed.events.some(event => event.phase === "tool_result")).toBe(false);
  }
});

test("a marker-only or failed tool result does not prove consumption of a shared entry or resource", async () => {
  const observed = await modelObserverFixture({ requests: ({ entry, resource, resourceBody }) => [
    { path: entry, content: "Shared model body" },
    { path: resource, content: resourceBody, isError: true },
  ] });
  expect(observed.decisions).toEqual([{ allowed: true }, { allowed: true }]);
  const results = observed.events.filter(event => event.phase === "tool_result");
  expect(results[0]).toMatchObject({ kind: "skill", bodyMatchesFile: false, resourceSuccess: false });
  expect(results[1]).toMatchObject({ kind: "resource", isError: true, resourceSuccess: false });
});

test("a cold shared URI may activate but cannot claim verified snapshot bytes from an invalid receipt", async () => {
  const observed = await modelObserverFixture({ record: { ...sharedRecord(), enabled: false }, requests: ({ body }) => [{ path: sharedRecord().ref, content: body }] });
  expect(observed.decisions).toEqual([{ allowed: true }]);
  expect(observed.events.filter(event => event.phase === "tool_result")).toMatchObject([{ kind: "skill-uri", bodyMatchesFile: false, resourceSuccess: false }]);
});

// The native-kind acceptance assertions run under the same Node runtime as the
// real RPC recipe. These are observer regressions, not host/model acceptance.
async function nativeKindsObserverCase(selected: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "broker-native-kinds-observer-"));
  const script = join(root, "observer-case.mjs");
  await writeFile(script, `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectNativeKindsContext, inspectNativeKindsReceipts, validateNativeKindsConfig } from ${JSON.stringify(import.meta.resolve("../../../scripts/notion-native-kinds.mjs"))};
const hash = value => createHash('sha256').update(value).digest('hex');
const xml = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const attribute = value => xml(value).replaceAll('"','&quot;');
const fixtures = Object.fromEntries(['skill','prompt','router'].map(kind => {
  const id = 'shared_skill:controlled:' + kind, snapshotId = 's_' + hash(kind), body = 'Complete ' + kind + ' body with <code>literal</code>.';
  return [kind, { record: { id, kind }, scope: 'a'.repeat(64), snapshotId, versionId: hash('version-' + kind), ref: 'skill://' + encodeURIComponent(id) + '/' + kind.toUpperCase() + '.md?snapshot=' + snapshotId, body, bodySha256: hash(body), escapedBodySha256: hash(xml(body)) }];
}));
const identity = kind => JSON.stringify(['notion', fixtures[kind].scope, kind, 'shared_skill', fixtures[kind].record.id]);
const task = (id, body = fixtures.prompt.body) => '<prompt-task invocation="' + id + '" session="session-1" generation="1" identity="' + attribute(identity('prompt')) + '" snapshot="' + fixtures.prompt.snapshotId + '" version="' + fixtures.prompt.versionId + '">\\n' + body + '\\n</prompt-task>';
const block = kind => '<context-broker-record kind="' + kind + '" name="controlled"><skill-ref>' + xml(fixtures[kind].ref) + '</skill-ref><snapshot-id>' + fixtures[kind].snapshotId + '</snapshot-id><body>\\n' + xml(fixtures[kind].body) + '\\n</body></context-broker-record>';
const receipt = kind => ({ kind, sourceId: 'notion', identity: identity(kind), loaded: true, recordId: fixtures[kind].record.id, snapshotId: fixtures[kind].snapshotId, versionId: fixtures[kind].versionId });
const loaded = records => [{ role: 'custom', customType: 'context-broker', details: { records } }];
const user = content => ({ role: 'user', content });
const inspect = (messages, marker, prompt, persistent) => inspectNativeKindsContext({ messages }, fixtures, { marker, prompt, persistent });
const selected = process.argv[2];
if (selected === 'prompt-history') {
  const first = user('TURN_ONE\\n' + task('invocation-1')), second = user('TURN_TWO\\n' + task('invocation-2'));
  const a = inspect([first], 'TURN_ONE', true, []);
  const b = inspect([first, { role:'assistant', content:'OK' }, second], 'TURN_TWO', true, []);
  assert.notEqual(a.invocation, b.invocation);
  assert.equal(b.currentPromptTasks, 1);
  inspectNativeKindsReceipts([first, second], fixtures, []);
  assert.throws(() => inspect([first, second, second], 'TURN_TWO', true, []), /one provider user message/);
} else if (selected === 'prompt-rejects') {
  assert.throws(() => inspect([user('TURN\\n' + task('i', 'Complete prompt body'))], 'TURN', true, []), /complete frozen public body/);
  assert.throws(() => inspect([user('TURN\\n' + task('i') + task('j'))], 'TURN', true, []), /exactly once/);
  assert.throws(() => inspect([user('TURN\\n' + task('i').replace(fixtures.prompt.snapshotId, 's_' + 'f'.repeat(64)))], 'TURN', true, []));
  assert.throws(() => inspectNativeKindsReceipts(loaded([receipt('prompt')]), fixtures, []), /Prompt must never/);
} else if (selected === 'router-member') {
  inspect([user(block('router')), user('ROUTER_TURN')], 'ROUTER_TURN', false, ['router']);
  inspectNativeKindsReceipts(loaded([receipt('router')]), fixtures, ['router']);
  assert.throws(() => inspect([user(block('router')), user('ROUTER_TURN\\n' + fixtures.skill.body)], 'ROUTER_TURN', false, ['router']), /unselected member body leaked/);
  inspect([user(block('router') + block('skill')), user('MEMBER_TURN')], 'MEMBER_TURN', false, ['router','skill']);
  inspectNativeKindsReceipts(loaded([receipt('router'), receipt('skill')]), fixtures, ['router','skill']);
  assert.throws(() => inspectNativeKindsReceipts(loaded([{ ...receipt('skill'), loaded: false }]), fixtures, ['skill']));
} else if (selected === 'mixed-resume') {
  const history = [user(block('skill') + block('router')), user('MIXED_ONE\\n' + task('i'))];
  const current = user('MIXED_TWO\\n' + task('j'));
  inspect([...history.slice(1), current, history[0]], 'MIXED_TWO', true, ['skill','router']);
  inspectNativeKindsReceipts(loaded([receipt('skill'), receipt('router')]), fixtures, ['skill','router']);
  assert.throws(() => inspect([...history, user(block('skill')), current], 'MIXED_TWO', true, ['skill','router']), /Only selected/);
  for (const duplicate of [fixtures.skill.body, xml(fixtures.skill.body)])
    assert.throws(() => inspect([...history, user(duplicate), current], 'MIXED_TWO', true, ['skill','router']), /exactly once across all provider messages/);
  assert.throws(() => inspectNativeKindsReceipts(loaded([receipt('skill'), { ...receipt('router'), versionId: 'f'.repeat(64) }]), fixtures, ['skill','router']));
  const config = { version:1, refs: Object.fromEntries(Object.entries(fixtures).map(([kind, fixture]) => [kind, fixture.ref.split('?')[0]])) };
  validateNativeKindsConfig(config);
  assert.throws(() => validateNativeKindsConfig({ ...config, refs: { ...config.refs, prompt: config.refs.skill } }));
  assert.throws(() => validateNativeKindsConfig({ ...config, refs: { ...config.refs, prompt: fixtures.prompt.ref } }));
} else throw new Error('Unexpected observer regression');
process.stdout.write(JSON.stringify({ selected, status:'passed' }));
`, { mode: 0o600 });
  return JSON.parse(execFileSync(node, [script, selected], { encoding: "utf8" }));
}

for (const selected of ["prompt-history", "prompt-rejects", "router-member", "mixed-resume"]) {
  test(`native kind acceptance observer: ${selected}`, async () => {
    expect(await nativeKindsObserverCase(selected)).toEqual({ selected, status: "passed" });
  });
}
