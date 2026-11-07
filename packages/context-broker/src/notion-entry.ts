import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SourceError } from "./notion-source";
import { retireOwnedCacheStage } from "./notion-cache-stage";
import { nativeResourcePath, parseNativeReference } from "./native-reference";
import type { SkillRecord } from "./types";
import type { ResourceReadFile, ResourceReadFileIdentity, ResourceReadWireFile } from "./resource-read-types";

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
async function verifiedFile(path: string, file: Pick<EntryFile, "bytes" | "sha256">, record: SkillRecord): Promise<void> {
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
    try {
      const mainPath = pathWithin(tree, record.entrypoint, record);
      await ensureDirectory(dirname(mainPath));
      await writeFile(mainPath, record.body, { mode: 0o600, flag: "wx" });
      await writeFile(join(stage, ".broker-entry.json"), JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
      if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
      try { await rename(stage, destination); }
      catch (error) { if (!object(error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error; await verify(); }
    } finally { await retireOwnedCacheStage(stage); }
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
  const destination = pathWithin(state.root, file.path, record);
  await ensureDirectory(dirname(destination));
  if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
  let exists = true;
  try { await lstat(destination); } catch (error) { if (!absent(error)) throw error; exists = false; }
  if (exists) {
    await verifiedFile(destination, file, record);
    // The CLI/SDK output contract verifies identical bytes and never overwrites.
    // Still call it: a local file cannot grant current source permission.
    await fetch(file, destination);
    await verifiedFile(destination, file, record);
  } else {
    const stage = join(dirname(state.root), ".resource-stage-" + randomUUID());
    try {
      await fetch(file, stage);
      if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
      await verifiedFile(stage, file, record);
      try { await link(stage, destination); }
      catch (error) { if (!object(error) || error.code !== "EEXIST") throw error; await verifiedFile(destination, file, record); }
    } finally { await retireOwnedCacheStage(stage); }
  }
  if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
  record.entryManifest = materialization(state.root, state.receipt, receipt, [...state.materialized_paths, file.path]);
  return destination;
}

/** Selected resources have their own immutable file projection. It does
 * not require a main entry file and cannot satisfy an entry/full-export receipt. */
function resourceRoot(record: SkillRecord, cache: string): string {
  if (!record.sourceScope || !/^[a-f0-9]{64}$/.test(record.sourceScope) || !record.id || !/^s_[a-f0-9]{64}$/.test(record.snapshotId ?? "")) fail(record, "SOURCE_PREPARATION_INVALID");
  return join(cache, "scopes", record.sourceScope, "records", hash(record.id), "resources", record.snapshotId!, "tree");
}
const resourceKey = (file: { path: string; file_id?: string }) => hash(JSON.stringify(file.file_id === undefined ? ["path", file.path] : ["file", file.file_id]));
const resourceReceipt = (record: SkillRecord, file: ResourceReadFileIdentity) => ({
  version: 1, scope: record.sourceScope, id: record.id, snapshot_id: record.snapshotId,
  file: { ref: file.ref, path: file.path, bytes: file.bytes, sha256: file.sha256, ...(file.file_id === undefined ? {} : { file_id: file.file_id }) },
});
async function publishResourceReceipt(record: SkillRecord, file: ResourceReadFileIdentity, cache: string, ensureDirectory: (path: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
  const receipt = resourceReceipt(record, file), parent = join(dirname(resourceRoot(record, cache)), "receipts");
  await ensureDirectory(parent);
  // Both public spellings point to one body; former path hints use the File ID key.
  const keys = new Set([resourceKey(file), resourceKey({ path: file.path })]);
  for (const key of keys) {
    const destination = join(parent, key), receiptPath = join(destination, "receipt.json");
    const verify = async () => {
      await ensureDirectory(destination);
      const info = await lstat(receiptPath);
      if (!info.isFile() || info.isSymbolicLink()) fail(record, "SOURCE_CACHE_UNSAFE");
      let actual: unknown;
      try { actual = JSON.parse(await readFile(receiptPath, "utf8")); } catch { fail(record); }
      if (!isDeepStrictEqual(actual, receipt)) fail(record);
    };
    let exists = true;
    try { await lstat(destination); } catch (error) { if (!absent(error)) throw error; exists = false; }
    if (exists) { await verify(); continue; }
    const stage = join(parent, ".receipt-stage-" + randomUUID());
    await ensureDirectory(stage);
    try {
      await writeFile(join(stage, "receipt.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
      if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
      try { await rename(stage, destination); }
      catch (error) { if (!object(error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error; await verify(); }
    } finally { await retireOwnedCacheStage(stage); }
  }
}
/** A verified local output hint only. The caller must still perform the SDK read
 * and bind its current result before delivering any bytes to the host. */
export async function cachedNotionResourceFile(record: SkillRecord, fixedRef: string, cache: string, ensureDirectory: (path: string) => Promise<void>): Promise<string | undefined> {
  const requested = parseNativeReference(fixedRef), root = resourceRoot(record, cache);
  const key = resourceKey({ path: requested.path, ...(requested.fileId === undefined ? {} : { file_id: requested.fileId }) });
  const path = join(dirname(root), "receipts", key, "receipt.json");
  let info;
  try { info = await lstat(path); } catch (error) { if (absent(error)) return undefined; throw error; }
  await ensureDirectory(dirname(path));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) fail(record, "SOURCE_CACHE_UNSAFE");
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { fail(record); }
  if (!object(value) || value.version !== 1 || value.scope !== record.sourceScope || value.id !== record.id || value.snapshot_id !== requested.snapshot || !object(value.file)) fail(record);
  const file = value.file;
  if (typeof file.ref !== "string" || typeof file.path !== "string" || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0
    || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || file.file_id !== undefined && typeof file.file_id !== "string") fail(record);
  const canonical = parseNativeReference(file.ref);
  if (canonical.selector !== requested.selector || canonical.snapshot !== requested.snapshot || canonical.path !== file.path || canonical.fileId !== file.file_id
    || requested.fileId === undefined && requested.path !== canonical.path || requested.fileId !== undefined && requested.fileId !== canonical.fileId) fail(record);
  const output = pathWithin(root, file.path, record);
  await ensureDirectory(dirname(output));
  try { await verifiedFile(output, { bytes: file.bytes, sha256: file.sha256 }, record); }
  catch (error) { if (absent(error)) return undefined; throw error; }
  return output;
}
async function publishResourceStage(record: SkillRecord, file: ResourceReadFileIdentity, stage: string, destination: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
  if (stage !== destination) {
    try { await link(stage, destination); }
    catch (error) { if (!object(error) || error.code !== "EEXIST") throw error; }
  }
  await verifiedFile(destination, file, record);
  if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
}
/** Publish exact SDK output without creating an entry projection or reading a main file. */
export async function publishNotionResourceFile(record: SkillRecord, file: ResourceReadFileIdentity, stage: string, cache: string, ensureDirectory: (path: string) => Promise<void>, signal?: AbortSignal): Promise<ResourceReadFileIdentity & Readonly<{ output: string }>> {
  if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
  const destination = pathWithin(resourceRoot(record, cache), file.path, record);
  await ensureDirectory(dirname(destination));
  await verifiedFile(stage, file, record);
  await publishResourceStage(record, file, stage, destination, signal);
  await publishResourceReceipt(record, file, cache, ensureDirectory, signal);
  return { ...file, output: destination };
}
export async function materializeNotionResourceBatch(record: SkillRecord, files: readonly ResourceReadWireFile[], cache: string, ensureDirectory: (path: string) => Promise<void>, signal?: AbortSignal): Promise<ResourceReadFile[]> {
  const root = resourceRoot(record, cache);
  const result: ResourceReadFile[] = [];
  for (const file of files) {
    if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
    if (file.encoding === "utf8") { result.push({ ...file, encoding: "utf8" }); continue; }
    const destination = pathWithin(root, file.path, record);
    await ensureDirectory(dirname(destination));
    let exists = true;
    try { await lstat(destination); } catch (error) { if (!absent(error)) throw error; exists = false; }
    if (!exists) {
      const bytes = Buffer.from(file.content, "base64");
      if (bytes.toString("base64") !== file.content || bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail(record, "SOURCE_RESPONSE_INVALID");
      const stage = join(dirname(destination), ".resource-stage-" + randomUUID());
      try {
        await writeFile(stage, bytes, { mode: 0o600, flag: "wx" });
        await publishResourceStage(record, file, stage, destination, signal);
      } finally { await retireOwnedCacheStage(stage); }
    } else await verifiedFile(destination, file, record);
    await publishResourceReceipt(record, file, cache, ensureDirectory, signal);
    if (signal?.aborted) fail(record, "SOURCE_CANCELLED");
    result.push({ ...file, encoding: "base64", output: destination });
  }
  return result;
}
