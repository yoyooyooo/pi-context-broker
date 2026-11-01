import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installCliWriteInvalidation } from "../src/cli-write-invalidation";
import { formatFindDiagnostics } from "../src/diagnostics";
import { matchesPreciseRecordToken, parseCatalogMember, preciseRecordToken, resolveCatalogReference } from "../src/discovery-records";
import { hostCliScope } from "../src/host-command";
import { discoverNotionSource, loadNotionSkill, ReferenceMiss } from "../src/notion-source";
import { sharedSkillId } from "../src/shared-skill-identity";
import { normalizeSources } from "../src/sources";
import { resolveViewDiscovery, VIEW_SELECTION_ENTRY } from "../src/view-discovery";
import type { ContentRecord, ExtensionAPI, ExtensionContext, SkillRecord, SourceConfig } from "../src/types";

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
  const state: Json = { catalog: listing(input.records ?? [record]), profile: listing([record], "profile"), explicit: listing([record], "view"), read, resources: { "scripts/fixed.bin": Buffer.from([0, 255, 13, 10]).toString("base64") } };
  await writeFile(logPath, "", { mode: 0o600 });
  await writeFile(executable, `
import {readFileSync,appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const [statePath,logPath,...args]=process.argv.slice(2),state=JSON.parse(readFileSync(statePath,'utf8'));
appendFileSync(logPath,JSON.stringify(args)+'\\n');
let value;
if(args[0]==='ctl'&&args[1]==='cache'&&args[2]==='identity')value={ok:true,identity:'a'.repeat(64),catalog_max_age_ms:3600000};
else if(args[0]==='list')value=args.includes('--view')?state.explicit:args.includes('--default-view')?state.profile:state.catalog;
else if(args[0]==='read')value=state.read;
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
  return { root, source, state, save, read, record, content,
    calls: async (): Promise<string[][]> => (await readFile(logPath, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)),
    clearCalls: () => writeFile(logPath, ""),
  };
}

test("shared identities encode each logical component and retain the actual page locator", async () => {
  expect(sharedSkillId("lib:team", "skill:one")).toBe("shared_skill:lib%3Ateam:skill%3Aone");
  expect(sharedSkillId("lib/team", "skill")).toBeUndefined();
  const f = await fixture(), result = await discoverNotionSource(f.source, f.root);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ id: "shared_skill:lib%3Ateam:skill%3Aone", enabled: true, locator: { page_id: page }, ref: "skill://shared_skill%3Alib%253Ateam%3Askill%253Aone/SKILL.md" });
  expect((await f.calls()).some(args => ["read", "export", "files"].includes(args[0]!))).toBe(false);
  expect(await readFile(result[0]!.path, "utf8")).not.toContain("Fixed shared body");
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

async function observeWrite(result: Json, operation = "update") {
  const handlers = new Map<string, unknown>(), changed: string[][] = [];
  const api: ExtensionAPI = { on(event, handler) { handlers.set(event, handler); } };
  const source: NotionSource = { type: "notion", id: "shared", namespace: "team", command: ["node", "ntn-skills.mjs"], database };
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

type ModelObserverRequest = { path: string; content: string; isError?: boolean };
async function modelObserverFixture(options: {
  record?: unknown;
  tamperedResource?: string;
  extraFile?: boolean;
  requests?: (paths: { entry: string; resource: string; directory: string; body: string; resourceBody: string }) => ModelObserverRequest[];
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
  const requests = options.requests?.({ entry, resource, directory, body, resourceBody }) ?? [{ path: entry, content: body }, { path: resource, content: resourceBody }];
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
for(const [index,request] of ${JSON.stringify(requests)}.entries()){
 const event={toolName:'read',toolCallId:'controlled-'+index,input:{path:request.path}};
 const decision=handlers.get('tool_call')(event);
 decisions.push(decision??{allowed:true});
 if(!decision?.block)handlers.get('tool_result')({...event,isError:request.isError??false,content:[{type:'text',text:request.content}]});
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
