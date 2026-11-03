import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SourceError } from "./notion-source";
import { nativeResourcePath, parseNativeReference } from "./native-reference";
import type { SkillRecord } from "./types";

export type EntryFile = { path: string; bytes: number; sha256: string; ref: string };
export type EntryManifest = {
  version: 1; root: string; receipt: string; manifest_id: string; files: readonly EntryFile[];
  manifest_complete: true; local_files_ready: boolean; materialized_paths: readonly string[];
};
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const absent = (error: unknown) => object(error) && error.code === "ENOENT";
function fail(record: SkillRecord, code = "SOURCE_OUTPUT_CONFLICT"): never { throw new SourceError(code, record.sourceId ?? "notion"); }
function pathWithin(root: string, path: string, record: SkillRecord) {
  if (!path || isAbsolute(path) || /[\\:\p{Cc}\p{Cf}\p{Cs}]/u.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) fail(record, "SOURCE_REFERENCE_INVALID");
  const target = resolve(root, path), within = relative(root, target);
  if (!within || within.startsWith(".." + sep) || within === ".." || isAbsolute(within)) fail(record, "SOURCE_REFERENCE_INVALID");
  return target;
}
function manifestFiles(record: SkillRecord, files: readonly EntryFile[]) {
  const paths = new Set<string>();
  for (const file of files) {
    pathWithin("/immutable-entry", file.path, record);
    if (paths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) fail(record, "SOURCE_PREPARATION_INVALID");
    paths.add(file.path);
    const reference = parseNativeReference(file.ref);
    if (reference.snapshot !== record.snapshotId || reference.path !== file.path || nativeResourcePath(reference, record) !== file.path) fail(record, "SOURCE_PREPARATION_INVALID");
    const binding = record.fileBindings?.find(value => value.path === file.path);
    if (reference.fileId !== binding?.file_id) fail(record, "SOURCE_PREPARATION_INVALID");
  }
  if (!paths.has(record.entrypoint!) || record.fileBindings?.some(binding => !paths.has(binding.path))) fail(record, "SOURCE_PREPARATION_INVALID");
  return files.map(file => ({ ...file })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function verifiedFile(path: string, file: EntryFile, record: SkillRecord): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(record, "SOURCE_CACHE_UNSAFE");
  const bytes = await readFile(path);
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail(record);
}
const stableReceipt = (record: SkillRecord, files: readonly EntryFile[]) => ({
  version: 1, projection: "entry", manifest_complete: true,
  scope: record.sourceScope, id: record.id, snapshot_id: record.snapshotId, version_id: record.versionId,
  entrypoint: record.entrypoint, ref: record.preparationBinding?.ref,
  files, ...(record.fileBindings ? { file_bindings: record.fileBindings } : {}),
});
function materialization(root: string, receipt: string, manifest: ReturnType<typeof stableReceipt>, paths: readonly string[]): EntryManifest {
  const materialized_paths = [...new Set(paths)].sort();
  return { version: 1, root, receipt, manifest_id: hash(JSON.stringify(manifest)), files: manifest.files,
    manifest_complete: true, local_files_ready: manifest.files.every(file => materialized_paths.includes(file.path)), materialized_paths };
}
/** Entry-ready storage has a separate projection and can never satisfy a full-export receipt. */
export async function publishNotionEntry(record: SkillRecord, files: readonly EntryFile[], cache: string, ensureDirectory: (path: string) => Promise<void>, signal?: AbortSignal): Promise<SkillRecord> {
  if (!record.body || !record.preparationBinding || !record.entrypoint || !record.snapshotId || !record.sourceScope) fail(record, "SOURCE_PREPARATION_INVALID");
  const manifest = manifestFiles(record, files), main = manifest.find(file => file.path === record.entrypoint)!;
  if (Buffer.byteLength(record.body) !== main.bytes || hash(record.body) !== main.sha256 || main.sha256 !== record.preparationBinding.body_sha256) fail(record, "SOURCE_PREPARATION_INVALID");
  const receipt = stableReceipt(record, manifest);
  const parent = join(cache, "scopes", record.sourceScope, "records", hash(record.id!), "entries");
  await ensureDirectory(parent);
  const destination = join(parent, record.snapshotId), root = join(destination, "tree"), receiptPath = join(destination, ".broker-entry.json");
  const verify = async () => {
    await ensureDirectory(destination); await ensureDirectory(root);
    let actual: unknown;
    try { actual = JSON.parse(await readFile(receiptPath, "utf8")); } catch { fail(record); }
    if (!isDeepStrictEqual(actual, receipt)) fail(record);
    await verifiedFile(pathWithin(root, record.entrypoint!, record), main, record);
  };
  let exists = true;
  try { await lstat(destination); } catch (error) { if (!absent(error)) throw error; exists = false; }
  if (exists) await verify();
  else {
    const stage = join(parent, ".entry-stage-" + randomUUID()), tree = join(stage, "tree");
    const mainPath = pathWithin(tree, record.entrypoint, record);
    await ensureDirectory(dirname(mainPath));
    await writeFile(mainPath, record.body, { mode: 0o600, flag: "wx" });
    await writeFile(join(stage, ".broker-entry.json"), JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
    if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
    try { await rename(stage, destination); }
    catch (error) { if (!object(error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error; await verify(); }
  }
  if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
  return { ...record, path: pathWithin(root, record.entrypoint, record),
    entryManifest: materialization(root, receiptPath, receipt, [record.entrypoint]) };
}
export function publicEntryMaterialization(record: SkillRecord) {
  const value = record.entryManifest;
  return value ? { manifest_complete: true, local_files_ready: value.local_files_ready, materialized_paths: [...value.materialized_paths], loaded: false } : undefined;
}
/** Fetch exactly one immutable manifest object. Stages and incomplete files are never ready paths. */
export async function materializeNotionEntryFile(record: SkillRecord, path: string, ensureDirectory: (path: string) => Promise<void>, fetch: (file: EntryFile, output: string) => Promise<void>, signal?: AbortSignal): Promise<string> {
  const state = record.entryManifest;
  if (!state || !record.entrypoint) fail(record, "SOURCE_PREPARATION_INVALID");
  const file = state.files.find(file => file.path === path);
  if (!file) fail(record, "FILE_NOT_FOUND");
  const receipt = stableReceipt(record, state.files);
  if (state.manifest_id !== hash(JSON.stringify(receipt))) fail(record);
  let actual: unknown;
  try { actual = JSON.parse(await readFile(state.receipt, "utf8")); } catch { fail(record); }
  if (!isDeepStrictEqual(actual, receipt)) fail(record);
  const stage = join(dirname(state.root), ".resource-stage-" + randomUUID());
  await ensureDirectory(stage);
  const output = join(stage, "content");
  await fetch(file, output);
  if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
  await verifiedFile(output, file, record);
  const destination = pathWithin(state.root, file.path, record);
  await ensureDirectory(dirname(destination));
  try { await link(output, destination); }
  catch (error) { if (!object(error) || error.code !== "EEXIST") throw error; await verifiedFile(destination, file, record); }
  if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
  record.entryManifest = materialization(state.root, state.receipt, receipt, [...state.materialized_paths, file.path]);
  return destination;
}
