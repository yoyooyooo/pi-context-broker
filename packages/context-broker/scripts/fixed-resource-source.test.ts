import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContentRecord, SkillRecord, SourceConfig } from "../src/types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const exists = (path: string) => stat(path).then(() => true, () => false);

// Isolated bundled SDK fixtures exercise the source/storage boundary. They never
// replace the repository SDK or contact Notion; each copy owns its module cache.
async function fixture(options: { proofVersion?: number | null; bytes?: Uint8Array } = {}) {
  const evidence = process.env.CONTEXT_BROKER_FIXED_RESOURCE_EVIDENCE ?? tmpdir();
  await mkdir(evidence, { recursive: true });
  const root = await realpath(await mkdtemp(join(evidence, "fixed-resource-source-")));
  await cp(new URL("../src", import.meta.url), join(root, "src"), { recursive: true });
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
  const proofVersion = options.proofVersion === undefined ? 1 : options.proofVersion;
  const sdkPath = join(root, "src/ntn-skills-sdk.mjs");
  await writeFile(sdkPath, `
import { writeFile, symlink } from 'node:fs/promises';
export const SDK_VERSION = 1, CONSUMER_CONTRACT_VERSION = 1, PACKAGE_VERSION = 'fixed-resource-fixture';
${proofVersion === null ? "" : `export const READ_OUTPUT_PROOF_VERSION = ${proofVersion};`}
export const calls = [];
let state;
export function configure(value) { state = value; }
export function parseDuration() { return 0; }
export function consume() { throw new Error('main preparation must not run'); }
export function decodeConsumeResult() { throw new Error('main decoder must not run'); }
export async function readSkill(target, options) {
  calls.push({ target, options });
  if (state.symlink) await symlink(state.symlink, options.output);
  else await writeFile(options.output, state.bytes, { flag: 'wx', mode: 0o600 });
  state.afterWrite?.();
  options.onRequestMetrics?.({ total_requests: 0, trace: [] });
  return { ...state.response, output: options.output, reused: false, ...state.overrides };
}
`);
  await writeFile(join(root, "src/ntn-skills-runtime.json"), JSON.stringify({ version: 1, package: "ntn-skills", package_version: "fixed-resource-fixture",
    sdk_version: 1, consumer_contract_version: 1, ...(proofVersion === null ? {} : { read_output_proof_version: proofVersion }) }));
  const sdk = await import(pathToFileURL(sdkPath).href);
  const boundary = await import(pathToFileURL(join(root, "src/notion-source.ts")).href);
  const id = "shared_skill:fixed-resource:owner", scope = hash("fixed resource scope"), version = hash("fixed resource version");
  const snapshot = "s_" + hash(JSON.stringify([scope, id, version])), prefix = "skill://" + encodeURIComponent(id) + "/";
  const main = "SKILL.md", path = "references/guide.md", bytes = Buffer.from(options.bytes ?? Buffer.from("\ufeffExact resource.\r\nSecond line.\r\n"));
  const content: ContentRecord = { id, kind: "skill", name: "owner", alias: "owner", description: "Fixed resource fixture", default_context: false, enabled: true,
    entrypoint: main, ref: prefix + main, locator: { type: "shared_skill", library_id: "fixed-resource", skill_id: "owner",
      page_id: "00000000-0000-4000-8000-000000000001", database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" } };
  const source: Extract<SourceConfig, { type: "notion" }> = { id: "notion", type: "notion", cacheDir: join(root, "cache"), activation: { offline: true }, prefetch: false };
  const record: SkillRecord = { ...content, source: "notion", sourceId: source.id, sourceScope: scope, path: join(root, "metadata/SKILL.md"),
    aliases: [], normalizedAliases: [], normalizedName: "owner", normalizedDescription: content.description, autoloadEnabled: false };
  const ref = prefix + path + "?snapshot=" + snapshot + "&file_id=guide";
  const response = { record: content, entrypoint: main, scope, snapshot_id: snapshot, version_id: version, path, ref, source: "local_snapshot",
    freshness: { policy: "pinned" }, materialization: { manifest_complete: true, local_files_ready: false, materialized_paths: [path], loaded: false },
    bytes: bytes.length, sha256: hash(bytes), entrypoint_sha256: hash("independent main commitment"),
    file_bindings: [{ file_id: "main", path: main, page_id: "00000000-0000-4000-8000-000000000001" },
      { file_id: "guide", path, page_id: "00000000-0000-4000-8000-000000000002" }] };
  const state = { bytes, response, overrides: {} as Record<string, unknown>, afterWrite: undefined as (() => void) | undefined, symlink: undefined as string | undefined };
  sdk.configure(state);
  const resourceRoot = join(source.cacheDir!, "scopes", scope, "records", hash(id), "resources", snapshot, "tree");
  const read = (fixedRef = ref, signal?: AbortSignal) => boundary.readFixedNotionResource(record, fixedRef, source, root, signal, "sdk");
  return { root, sdk, boundary, source, record, content, response, state, ref, prefix, snapshot, path, main, bytes, resourceRoot, read };
}

test("one scalar output read publishes exact text with an independent owner commitment and no entry", async () => {
  const f = await fixture(), result = await f.read();
  expect(result.selection).toEqual({ scope: f.record.sourceScope, owner: f.record.id, snapshot_id: f.snapshot, version_id: f.response.version_id });
  expect(result.ownerBinding.body_sha256).toBe(f.response.entrypoint_sha256);
  expect(result.ownerBinding.ref).toBe(f.prefix + f.main + "?snapshot=" + f.snapshot + "&file_id=main");
  expect(result.file).toEqual({ requested_ref: f.ref, ref: f.ref, path: f.path, file_id: "guide", bytes: f.bytes.length, sha256: hash(f.bytes), output: join(f.resourceRoot, f.path) });
  expect(await readFile(result.file.output)).toEqual(f.bytes);
  expect(Object.keys(result).sort()).toEqual(["entrypoint", "file", "ownerBinding", "selection"]);
  expect(f.record.body).toBeUndefined(); expect(f.record.entryManifest).toBeUndefined();
  expect(await exists(join(f.resourceRoot, f.main))).toBe(false);
  expect(f.sdk.calls).toHaveLength(1); expect(f.sdk.calls[0]).toMatchObject({ target: f.ref, options: { offline: true } });
  expect(await f.read()).toEqual(result);
  await writeFile(result.file.output, "corrupt");
  await expect(f.read()).rejects.toMatchObject({ code: "SOURCE_OUTPUT_CONFLICT" });
});

test("scalar output preserves empty and binary resources beyond the batch maximum", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(16 * 1024 * 1024 + 7, 255)]) {
    const f = await fixture({ bytes }), result = await f.read();
    expect(await readFile(result.file.output)).toEqual(bytes);
    expect(result.file.bytes).toBe(bytes.length); expect(result.file.sha256).toBe(hash(bytes));
    expect(f.sdk.calls).toHaveLength(1);
    expect(f.sdk.calls[0].options.budget).toBeUndefined();
  }
});

test("stable File IDs accept old path hints and main aliases retain the main route", async () => {
  const f = await fixture(), old = f.ref.replace(f.path, "former/guide.md");
  expect((await f.read(old)).file).toMatchObject({ requested_ref: old, ref: f.ref, path: f.path, file_id: "guide" });
  const main = await fixture();
  main.state.response = { ...main.response, path: main.main, ref: main.prefix + main.main + "?snapshot=" + main.snapshot + "&file_id=main",
    sha256: hash(main.bytes), entrypoint_sha256: hash(main.bytes) };
  expect(await main.read(main.ref.replace("file_id=guide", "file_id=main"))).toBeUndefined();
  expect(main.sdk.calls).toHaveLength(1); expect(await exists(main.resourceRoot)).toBe(false);
});

test("older SDKs and custom transports fall back before reading or staging a resource", async () => {
  const f = await fixture({ proofVersion: null });
  expect(await f.read()).toBeUndefined();
  expect(await f.boundary.readFixedNotionResource(f.record, f.ref, f.source, f.root)).toBeUndefined();
  expect(await f.boundary.readFixedNotionResource(f.record, f.ref, { ...f.source, command: ["must-not-run"] }, f.root, undefined, "sdk")).toBeUndefined();
  expect(f.sdk.calls).toHaveLength(0); expect(await exists(f.source.cacheDir!)).toBe(false);
  const incompatible = await fixture({ proofVersion: 2 });
  await expect(incompatible.read()).rejects.toMatchObject({ code: "SOURCE_SDK_INCOMPATIBLE" });
  expect(incompatible.sdk.calls).toHaveLength(0); expect(await exists(incompatible.source.cacheDir!)).toBe(false);
});

test("scalar output rejects foreign identities and malformed proof before immutable publication", async () => {
  const cases = [
    { override: { scope: hash("foreign") }, code: "SOURCE_IDENTITY_MISMATCH" },
    { override: { snapshot_id: "s_" + hash("foreign") }, code: "SOURCE_IDENTITY_MISMATCH" },
    { override: { entrypoint_sha256: "invalid" }, code: "SOURCE_RESPONSE_INVALID" },
    { override: { sha256: "invalid" }, code: "SOURCE_RESPONSE_INVALID" },
    { override: { output: "/foreign/output" }, code: "SOURCE_PREPARATION_INVALID" },
    { override: { bytes: -1 }, code: "SOURCE_RESPONSE_INVALID" },
    { override: { reused: "yes" }, code: "SOURCE_PREPARATION_INVALID" },
    { override: { file_bindings: [] }, code: "SOURCE_IDENTITY_MISMATCH" },
  ];
  for (const { override, code } of cases) {
    const f = await fixture(); f.state.overrides = override;
    await expect(f.read()).rejects.toMatchObject({ code });
    expect(await exists(f.resourceRoot)).toBe(false);
  }
});

test("corrupt or symlinked SDK output and cancellation never publish ready resource bytes", async () => {
  const corrupt = await fixture(); corrupt.state.bytes = Buffer.from("corrupt");
  await expect(corrupt.read()).rejects.toMatchObject({ code: "SOURCE_OUTPUT_CONFLICT" });
  expect(await exists(join(corrupt.resourceRoot, corrupt.path))).toBe(false);
  const linked = await fixture(), target = join(linked.root, "foreign-output");
  await writeFile(target, linked.bytes); linked.state.symlink = target;
  await expect(linked.read()).rejects.toMatchObject({ code: "SOURCE_CACHE_UNSAFE" });
  const cancelled = await fixture(), controller = new AbortController();
  cancelled.state.afterWrite = () => controller.abort();
  await expect(cancelled.read(cancelled.ref, controller.signal)).rejects.toMatchObject({ code: "SOURCE_CANCELLED" });
  expect(await exists(cancelled.resourceRoot)).toBe(false);
  const before = await fixture();
  await expect(before.read(before.ref, controller.signal)).rejects.toMatchObject({ code: "SOURCE_CANCELLED" });
  expect(before.sdk.calls).toHaveLength(0); expect(await exists(before.source.cacheDir!)).toBe(false);
});
