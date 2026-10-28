import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildRegistryFromRoots, normalizeKey } from "./skill-records";
import { discoverNotionSource, loadNotionSkill, SourceError, ReferenceMiss, sourceFailureMessage } from "./notion-source";
import type { ConfigFile, NotionListObservation, SkillRecord, SourceConfig, SourcePolicy, ScanConfig, DiscoveryResult, SourceFailure } from "./types";

export { SourceError } from "./notion-source";
export type SourceOptions = { signal?: AbortSignal; stale?: boolean; refreshSourceIds?: readonly string[] };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never { throw new SourceError("SOURCE_CONFIG_INVALID", "configuration"); }
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) invalid();
  return value;
}
function optionalString(value: unknown): string | undefined { return value === undefined ? undefined : string(value); }
function boolean(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") invalid();
  return value as boolean | undefined;
}
function policy(value: unknown): SourcePolicy | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) invalid();
  const maxAge = optionalString(value.maxAge);
  if (maxAge !== undefined && !/^(?:0|\d+[smhd])$/.test(maxAge)) invalid();
  return { maxAge, offline: boolean(value.offline) };
}
function scan(value: unknown): ScanConfig | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) invalid();
  for (const key of ["maxDepth", "maxSkillBytes"]) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) invalid();
  }
  const ignore = value.ignore === undefined ? undefined : strings(value.ignore);
  return { maxDepth: value.maxDepth as number | undefined, maxSkillBytes: value.maxSkillBytes as number | undefined, ignore };
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) invalid();
  return value.map(string);
}

export function normalizeSources(value: unknown): SourceConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalid();
  const seen = new Set<string>();
  return value.map((raw): SourceConfig => {
    if (!object(raw)) invalid();
    const id = string(raw.id);
    if (!/^[\p{L}\p{N}._-]+$/u.test(id)) invalid();
    if (seen.has(id)) invalid();
    seen.add(id);
    const namespace = optionalString(raw.namespace);
    if (namespace !== undefined && !/^[\p{L}\p{N}._-]+$/u.test(namespace)) invalid();
    const common = { id, enabled: boolean(raw.enabled), namespace };
    if (raw.type === "filesystem") {
      const roots = strings(raw.roots);
      if (roots.length === 0) invalid();
      return { ...common, type: "filesystem", roots, scan: scan(raw.scan), requireAutoload: boolean(raw.requireAutoload) };
    }
    if (raw.type !== "notion") invalid();
    let command: string | string[] | undefined;
    if (raw.command !== undefined) {
      command = Array.isArray(raw.command) ? strings(raw.command) : string(raw.command);
      if (Array.isArray(command) && command.length === 0) invalid();
    }
    if (raw.requestTimeoutMs !== undefined && (!Number.isSafeInteger(raw.requestTimeoutMs) || (raw.requestTimeoutMs as number) <= 0 || (raw.requestTimeoutMs as number) > 2_147_483_647)) invalid();
    return {
      ...common, type: "notion", command,
      database: optionalString(raw.database), default_view_id: optionalString(raw.default_view_id), cacheDir: optionalString(raw.cacheDir),
      discovery: policy(raw.discovery), activation: policy(raw.activation), requestTimeoutMs: raw.requestTimeoutMs as number | undefined,
    };
  });
}


export async function discoverSources(config: ConfigFile, cwd = process.cwd(), options: SourceOptions & { refresh?: boolean } = {}): Promise<SkillRecord[] & { lists?: NotionListObservation[]; failures?: SourceFailure[] }> {
  const records: Array<SkillRecord> & { lists?: NotionListObservation[]; failures?: SourceFailure[] } = [];
  const lists: NotionListObservation[] = [];
  const failures: SourceFailure[] = [];
  for (const source of normalizeSources(config.sources) ?? []) {
    if (source.enabled === false) continue;
    if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
    if (source.type === "notion") {
      try {
        const discovered = await discoverNotionSource(source, cwd, { ...options, refresh: options.refresh || !source.discovery?.offline && options.refreshSourceIds?.includes(source.id) });
        records.push(...discovered);
        lists.push(discovered.list);
        failures.push(...discovered.failures);
      }
      catch (error) {
        if (error instanceof SourceError) throw error;
        throw new SourceError("SOURCE_STORAGE_ERROR", source.id);
      }
      continue;
    }
    const roots = source.roots.map((root) => resolve(cwd, root === "~" ? homedir() : root.startsWith("~/") ? `${homedir()}/${root.slice(2)}` : root));
    for (const root of roots) {
      try { if (!(await stat(root)).isDirectory()) throw new Error(); }
      catch { throw new SourceError("SOURCE_FILESYSTEM_UNAVAILABLE", source.id); }
    }
    const scanned = await buildRegistryFromRoots(roots, source.requireAutoload ?? config.requireAutoload ?? true, source.scan ?? config.scan);
    const identities = new Set<string>();
    const sourceRecords: SkillRecord[] = [];
    for (const record of scanned) {
      let path: string;
      try { path = await realpath(record.path); }
      catch (error) {
        if (object(error) && (error.code === "ENOENT" || error.code === "ENOTDIR") && error.path === record.path) continue;
        throw new SourceError("SOURCE_FILESYSTEM_UNAVAILABLE", source.id);
      }
      if (identities.has(path)) continue;
      identities.add(path);
      const { body: _body, ...metadata } = record;
      sourceRecords.push({ ...metadata, path, sourceId: source.id, id: `local:${path}`, source: "local", sourceScope: JSON.stringify(roots), locator: { type: "local", id: path, entry: path }, ref: path });
    }
    const counts = new Map<string, number>();
    for (const record of sourceRecords) counts.set(record.normalizedName, (counts.get(record.normalizedName) ?? 0) + 1);
    for (const record of sourceRecords) {
      const base = normalizeKey(record.name);
      const disambiguator = counts.get(record.normalizedName)! > 1 ? `@${encodeURIComponent(record.id!).replace(/[!'()*.]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}` : "";
      record.token = `${source.namespace ?? source.id}/${base}${disambiguator}`;
    }
    records.push(...sourceRecords);
  }
  if (lists.length > 0) Object.defineProperty(records, "lists", { value: lists });
  if (failures.length > 0) Object.defineProperty(records, "failures", { value: failures });
  return records;
}

export async function discoverSourceCatalog(config: ConfigFile, cwd = process.cwd(), options: SourceOptions & { refresh?: boolean } = {}): Promise<DiscoveryResult<SkillRecord>> {
  const records: SkillRecord[] = [];
  const failures: SourceFailure[] = [];
  const lists: NotionListObservation[] = [];
  for (const source of normalizeSources(config.sources) ?? []) {
    if (source.enabled === false) continue;
    try {
      const discovered = await discoverSources({ ...config, sources: [source] }, cwd, options);
      records.push(...discovered);
      if (discovered.lists) lists.push(...discovered.lists);
      if (discovered.failures) failures.push(...discovered.failures);
    }
    catch (error) {
      if (options.signal?.aborted) throw error;
      const code = error instanceof SourceError ? error.code : "SOURCE_STORAGE_ERROR";
      failures.push({ sourceId: source.id, namespace: source.namespace ?? source.id, type: source.type, code, message: sourceFailureMessage(code) });
    }
  }
  return { records, failures, lists };
}

export function assertSourceAvailable(query: string, failures: SourceFailure[], native = false): void {
  const failure = failures.filter(item => item.blocking !== false).find(item => native
    ? query.startsWith((item.namespace + "/").replace(/[^a-z0-9-]/g, "-"))
    : query.startsWith(item.namespace + "/") || normalizeKey(item.namespace) !== "local" && query.includes("@") && normalizeKey(query.slice(query.lastIndexOf("@") + 1)) === normalizeKey(item.namespace));
  if (failure) throw new SourceError(failure.code, failure.sourceId);
}

export function formatSourceFailures(failures: SourceFailure[]): string[] {
  return failures.map(failure => `Source ${failure.sourceId}: ${failure.blocking === false ? "partial" : "unavailable"} (${failure.code}). ${failure.message}`);
}

async function selectedFile<T>(path: string, sourceId: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (object(error) && (error.code === "ENOENT" || error.code === "ENOTDIR") && error.path === path) throw new ReferenceMiss(sourceId);
    throw error;
  }
}

export async function loadSourceSkill(record: SkillRecord, config: ConfigFile, cwd = process.cwd(), options: SourceOptions = {}): Promise<SkillRecord> {
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", record.sourceId ?? "filesystem");
  if (!record.sourceId) {
    const body = await selectedFile(record.path, "local", () => readFile(record.path, "utf8"));
    return { ...record, body };
  }
  const source = (normalizeSources(config.sources) ?? []).find((candidate) => candidate.id === record.sourceId);
  if (!source || source.enabled === false) throw new SourceError("SOURCE_UNAVAILABLE", record.sourceId);
  if (source.type === "notion") {
    try { return await loadNotionSkill(record, source, cwd, options); }
    catch (error) {
      if (error instanceof SourceError || error instanceof ReferenceMiss) throw error;
      throw new SourceError("SOURCE_STORAGE_ERROR", source.id);
    }
  }
  const path = await selectedFile(record.path, source.id, () => realpath(record.path));
  if (record.locator?.type !== "local" || record.locator.id !== path) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  // Re-discovery also verifies that the record still belongs to the configured roots.
  const records = await discoverSources({ ...config, sources: [source] }, cwd, options);
  if (!records.some((candidate) => candidate.locator?.type === "local" && candidate.locator.id === path)) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  const body = await selectedFile(path, source.id, () => readFile(path, "utf8"));
  return { ...record, path, body };
}
