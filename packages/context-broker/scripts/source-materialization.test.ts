import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { currentNotionFixture } from "./fixtures/current-notion-source";
import { createInputReceipt } from "../src/skill-preparation";
import { needsSourceMaterialization } from "../src/source-materialization";
import { SourceError } from "../src/notion-source";
import type { SourceMaterializationRequest, SourceMaterializationReceipt, SourceMemberCandidate } from "../src/source-materialization-contract";
import type { ExtensionContext } from "../src/types";

test("only a precise missing current contract can enter explicit preparation", () => {
  for (const code of ["CURRENT_SCHEMA_REQUIRED", "CURRENT_SKILL_NOT_READY", "CURRENT_SOURCE_NOT_READY", "CURRENT_SOURCE_INCOMPLETE"])
    expect(needsSourceMaterialization(new SourceError(code, "notion"))).toBe(true);
  for (const code of ["AUTH_REQUIRED", "ACCESS_DENIED", "SOURCE_IDENTITY_MISMATCH", "STATE_CORRUPT", "INVALID_AUTHOR_CONTENT", "HTTP_ERROR"])
    expect(needsSourceMaterialization(new SourceError(code, "notion"))).toBe(false);
  expect(needsSourceMaterialization(Object.assign(new Error("CURRENT_SKILL_NOT_READY"), { code: "CURRENT_SKILL_NOT_READY" }))).toBe(false);
  const required = (codes: string[]) => new SourceError("PREPARE_REQUIRED_UNAVAILABLE", "notion", undefined,
    { preparation: { errors: codes.map(code => ({ code })) } });
  expect(needsSourceMaterialization(required(["CURRENT_SKILL_NOT_READY", "CURRENT_SOURCE_NOT_READY"]))).toBe(true);
  expect(needsSourceMaterialization(required(["CURRENT_SKILL_NOT_READY", "ACCESS_DENIED"]))).toBe(false);
  expect(needsSourceMaterialization(required([]))).toBe(false);
});

async function fixture() {
  const f = await currentNotionFixture();
  const management = `export const SOURCE_MATERIALIZATION_VERSION=1, PACKAGE_VERSION='current-source-fixture';
export const calls=[]; let handler; export function configure(value){handler=value;}
export async function materializeSource(input,options){calls.push({input,options});return handler(input,options);}`;
  const path = join(f.root, "src/ntn-skills-management.mjs");
  await writeFile(path, management);
  const manifestPath = join(f.root, "src/ntn-skills-runtime.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, source_materialization_version: 1,
    management_sha256: createHash("sha256").update(management).digest("hex") }));
  const controlled: { configure(handler: (request: SourceMaterializationRequest) => Promise<unknown>): void;
    calls: Array<{ input: SourceMaterializationRequest }> } = await import(pathToFileURL(path).href);
  const api: typeof import("../src/source-materialization") = await import(pathToFileURL(join(f.root, "src/source-materialization.ts")).href);
  const ctx: ExtensionContext = { cwd: f.root, sessionManager: { getSessionId: () => "accepted", getBranch: () => [] } };
  const candidate: SourceMemberCandidate = { type: "source_member", library_id: f.source.library!, scope: f.selected.sourceScope!,
    source_id: "registered-origin", member_key: "skills/entry", expected_skill_id: "entry", registration_digest: "b".repeat(64), expected_source_commit: "c".repeat(40),
    name: f.record.name, alias: f.record.alias, description: f.record.description, enabled: true, readiness: "materializable", record: f.record };
  const ready = (request: SourceMaterializationRequest): SourceMaterializationReceipt => ({ version: 1, request_id: request.request_id,
    library_id: request.library, scope: candidate.scope, target: request.target, status: "ready", operation_id: "accepted-operation",
    ...(request.authorization_root ? { authorization_root: request.authorization_root } : {}), records: [f.record], affected_skill_ids: ["entry"],
    source_revisions: [{ source_id: candidate.source_id, revision: "d".repeat(64) }], effects: { remote_writes: "management", projection: "none" } });
  controlled.configure(async request => ready(request));
  const receipts: SourceMaterializationReceipt[] = [];
  const input = (text = "$entry@notion") => ({ candidate, source: f.source, receipt: createInputReceipt({ text, source: "rpc" }, ctx),
    query: "entry@notion", purpose: "use" as const, ctx, onReceipt: (value: SourceMaterializationReceipt) => { receipts.push(value); } });
  return { ...f, api, controlled, ctx, candidate, ready, receipts, input };
}

test("explicit preparation returns metadata and a separate receipt before ordinary readonly consumption", async () => {
  const f = await fixture();
  const result = await f.api.materializeExplicitCandidate(f.input());
  expect(result.record).toEqual(f.record);
  expect(result.record).not.toHaveProperty("body");
  expect(f.receipts).toEqual([result.receipt]);
  expect(f.calls).toEqual([]);
  expect(f.controlled.calls[0]!.input.target).toMatchObject({ source_id: "registered-origin", expected_source_commit: "c".repeat(40) });
  const graph = await f.boundary.prepareNotionSkills([f.selected], f.source, f.root, { purpose: "use", refresh: true });
  expect(graph.records[0]!.body).toBe(f.body);
  expect(graph.effects).toMatchObject({ remote_writes: "none", author_content: "unchanged" });
  expect(f.calls.map(call => call.operation)).toEqual(["consume"]);
  expect(f.controlled.calls).toHaveLength(1);
});

test("code examples, offline policy and a retired input cannot dispatch management", async () => {
  const f = await fixture();
  for (const text of ["`$entry@notion`", "> $entry@notion", "    $entry@notion", "entry@notion"])
    await expect(f.api.materializeExplicitCandidate(f.input(text))).rejects.toMatchObject({ code: "SOURCE_MATERIALIZATION_UNAUTHORIZED" });
  const accepted = f.input();
  await expect(f.api.materializeExplicitCandidate({ ...accepted, source: { ...f.source, activation: { offline: true } } })).rejects.toMatchObject({ code: "SOURCE_MATERIALIZATION_BLOCKED" });
  await expect(f.api.materializeExplicitCandidate({ ...accepted, ctx: { ...f.ctx, cwd: f.root + "/another" } })).rejects.toMatchObject({ code: "SOURCE_CANCELLED" });
  expect(f.controlled.calls).toEqual([]);
  expect(f.receipts).toEqual([]);
});

test("cancellation keeps a late durable receipt separate from current input delivery", async () => {
  const f = await fixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.controlled.configure(async request => { started.resolve(); await release.promise; return f.ready(request); });
  const controller = new AbortController();
  const running = f.api.materializeExplicitCandidate({ ...f.input(), signal: controller.signal })
    .then(value => ({ value }), error => ({ error }));
  await started.promise; controller.abort(); release.resolve();
  expect(await running).toMatchObject({ error: { code: "SOURCE_CANCELLED", materialization: { status: "ready", effects: { remote_writes: "management" } } } });
  expect(f.receipts).toHaveLength(1);
  expect(f.calls).toEqual([]);
  expect(f.controlled.calls).toHaveLength(1);
});

test("an existing physical page cannot be rebound by an otherwise valid ready receipt", async () => {
  const f = await fixture();
  if (f.record.locator.type !== "shared_skill") throw new Error("Expected a physical Skill");
  const moved = { ...f.record, locator: { ...f.record.locator, page_id: "00000000-0000-4000-8000-000000000090" } };
  f.controlled.configure(async request => ({ ...f.ready(request), records: [moved] }));
  await expect(f.api.materializeExplicitCandidate(f.input())).rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
  expect(f.receipts).toEqual([]);
  expect(f.calls).toEqual([]);
});

test("unknown management effects never become a zero-write consumption result", async () => {
  const f = await fixture();
  f.controlled.configure(async request => ({ ...f.ready(request), status: "pending", records: [], source_revisions: [],
    affected_skill_ids: [], effects: { remote_writes: "unknown", projection: "none" } }));
  await expect(f.api.materializeExplicitCandidate(f.input())).rejects.toMatchObject({ code: "SOURCE_MATERIALIZATION_PENDING",
    materialization: { effects: { remote_writes: "unknown" } }, details: { effects: { remote_writes: "none" } } });
  expect(f.receipts[0]!.effects.remote_writes).toBe("unknown");
  expect(f.calls).toEqual([]);
});

test("Requires discovery binds the exact fresh physical root and rejects incomplete or foreign proof", async () => {
  const f = await fixture();
  if (f.record.locator.type !== "shared_skill") throw new Error("Expected a physical Skill");
  const authorization = { skill_id: "entry", page_id: f.record.locator.page_id, requires_digest: "e".repeat(64) };
  const dependency = { ...f.candidate, expected_skill_id: "required", member_key: "skills/required",
    record: { ...f.record, id: "skill://required?library=" + f.source.library, ref: "skill://required/SKILL.md?library=" + f.source.library,
      locator: { ...f.record.locator, skill_id: "required", page_id: "00000000-0000-4000-8000-000000000002" } } };
  const proof = { version: 1, library_id: f.source.library, scope: f.candidate.scope, coverage: "complete", candidates: [dependency], failures: [],
    root: f.record, authorization_root: authorization, effects: { remote_writes: "none" } };
  f.state.sourceMembers = async () => proof;
  const result = await f.boundary.discoverNotionRequiredSourceMembers(f.source, f.root, f.selected);
  expect(result.authorization).toEqual(authorization);
  expect(f.calls[0]!.sourceMembersInput).toEqual({ library: f.source.library, requires_of: "entry" });
  for (const patch of [ { coverage: "partial" }, { scope: "f".repeat(64) }, { authorization_root: { ...authorization, skill_id: "other" } },
    { failures: [{ source_id: "unavailable", code: "ACCESS_DENIED" }] } ]) {
    f.state.sourceMembers = async () => ({ ...proof, ...patch });
    await expect(f.boundary.discoverNotionRequiredSourceMembers(f.source, f.root, f.selected)).rejects.toBeDefined();
  }
  expect(f.controlled.calls).toEqual([]);
});


test("missing manager configuration remains actionable without accepting external error text", async () => {
  const f = await fixture();
  f.controlled.configure(async () => { throw Object.assign(new Error("sensitive remote details"), { code: "SOURCE_MANAGER_REQUIRED" }); });
  await expect(f.api.materializeExplicitCandidate(f.input())).rejects.toMatchObject({ code: "SOURCE_MANAGER_REQUIRED",
    message: "context-broker source operation failed (SOURCE_MANAGER_REQUIRED)", materialization: { remote_writes: "unknown" } });
  expect(f.receipts).toEqual([]);
  expect(f.calls).toEqual([]);
});


test("a preflight rejection still reaches receipt invalidation without authorizing consumption", async () => {
  const f = await fixture();
  f.controlled.configure(async request => ({ ...f.ready(request), status: "blocked", reason: "SOURCE_REGISTRATION_CHANGED",
    records: [], affected_skill_ids: [], source_revisions: [], effects: { remote_writes: "none", projection: "none" } }));
  await expect(f.api.materializeExplicitCandidate(f.input())).rejects.toMatchObject({ code: "SOURCE_MATERIALIZATION_BLOCKED" });
  expect(f.receipts).toHaveLength(1);
  expect(f.receipts[0]).toMatchObject({ target: { expected_skill_id: "entry" }, affected_skill_ids: [], effects: { remote_writes: "none" } });
  expect(f.calls).toEqual([]);
});
