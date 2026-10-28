import { Schema } from "effect";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeKey } from "./skill-records";
import type { ContentRecord, NotionListObservation, NotionView, SkillRecord, SourceConfig, SourcePolicy, SourceFailure } from "./types";

type NotionSource = Extract<SourceConfig, { type: "notion" }>;
type Options = { signal?: AbortSignal; refresh?: boolean; stale?: boolean; view?: string; defaultView?: boolean };
type NotionDirectory = SkillRecord[] & { list: NotionListObservation; failures: SourceFailure[]; view?: NotionView | null };
type Json = Record<string, unknown>;
const PageLocator = Schema.Struct({ type: Schema.Literal("notion_page"), page_id: Schema.String, database_id: Schema.String, data_source_id: Schema.String });
const SubscriptionLocator = Schema.Struct({ type: Schema.Literal("notion_subscription"), subscription_id: Schema.String, database_id: Schema.String, data_source_id: Schema.String, target_database_id: Schema.String });
const ContentSchema = Schema.Struct({ id: Schema.String, kind: Schema.Literals(["skill", "router", "prompt"]), locator: Schema.Union([PageLocator, SubscriptionLocator]), name: Schema.String, alias: Schema.String, description: Schema.String, default_context: Schema.Boolean, entrypoint: Schema.String, ref: Schema.String, upstream: Schema.optional(Schema.Struct({ repo: Schema.String })) });
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SNAPSHOT = /^s_[0-9a-f]{64}$/;
const CLI_CODES: Record<string, true | undefined> = Object.fromEntries("SKILL_NOT_FOUND SKILL_AMBIGUOUS INVALID_SKILL_NAME CATALOG_INCOMPLETE AUTH_REQUIRED ACCESS_DENIED NTN_UNAVAILABLE NOTION_REQUEST_FAILED RATE_LIMITED SNAPSHOT_MISSING SNAPSHOT_CONFLICT DATABASE_NOT_FOUND DATABASE_AMBIGUOUS OUTPUT_CONFLICT MARKDOWN_INCOMPLETE INVALID_REFERENCES REFERENCE_PATH_CONFLICT REFERENCE_NOT_FOUND UNSUPPORTED_FILE INPUT_FAILED INVALID_INPUT FILE_TOO_LARGE FILE_NOT_FOUND BINARY_FILE INVALID_REF INVALID_PATH INVALID_RANGE INVALID_ARGUMENT INVALID_ARCHIVE INVALID_SKILL ARCHIVE_TOO_LARGE STATE_CORRUPT STORAGE_ERROR OUTPUT_FAILED CACHE_MISSING CACHE_SCOPE_UNAVAILABLE CACHE_INCOMPLETE INVALID_SNAPSHOT INVALID_RESPONSE NOT_SKILLS_DATABASE DOWNLOAD_FAILED CRYPTO_ERROR INVALID_SOURCE SOURCE_AMBIGUOUS INTERNAL_ERROR INVALID_VIEW VIEW_SCOPE_MISMATCH VIEW_INCOMPLETE VIEW_QUERY_EXPIRED VIEW_MEMBER_UNAVAILABLE NOT_FOUND".split(" ").map((code) => [code, true as const]));

export class SourceError extends Error {
  readonly code: string;
  readonly sourceId: string;
  readonly exitCode?: number;
  constructor(code: string, sourceId: string, exitCode?: number) {
    super(`context-broker source operation failed (${code})`);
    this.name = "SourceError";
    this.code = code;
    this.sourceId = sourceId;
    this.exitCode = exitCode;
  }
}

/** A target lookup miss, distinct from missing resources or unavailable sources. */
export class ReferenceMiss extends Error {
  constructor(readonly sourceId: string) { super("Content reference is unavailable"); this.name = "ReferenceMiss"; }
}
function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function decodeError(source: NotionSource): never { throw new SourceError("SOURCE_RESPONSE_INVALID", source.id); }
function text(value: unknown, source: NotionSource, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || value.includes("\0")) decodeError(source);
  return value;
}
function validAlias(alias: string): boolean {
  if (!alias || alias.startsWith("-") || !/^(?:[\p{L}\p{M}\p{N}_.~-]|%[0-9A-F]{2})+$/u.test(alias)) return false;
  try { return !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(decodeURIComponent(alias)); }
  catch { return false; }
}
function contentRecord(value: unknown, source: NotionSource): ContentRecord {
  let item: ContentRecord;
  try { item = Schema.decodeUnknownSync(ContentSchema)(value, { onExcessProperty: "error" }); }
  catch { return decodeError(source); }
  const locator = item.locator;
  if (locator.type === "local") return decodeError(source);
  const page = locator.type === "notion_page" ? locator.page_id : locator.subscription_id;
  const canonical = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const entrypoint = { skill: "SKILL.md", router: "ROUTER.md", prompt: "PROMPT.md" }[item.kind];
  const selector = locator.type === "notion_page" ? page : "upstream:" + page;
  if (!canonical.test(page) || !canonical.test(locator.database_id) || !canonical.test(locator.data_source_id) || (locator.type === "notion_subscription" && (!canonical.test(locator.target_database_id) || item.kind !== "router")) || item.id !== locator.type + ":" + page || item.entrypoint !== entrypoint || item.ref !== "skill://" + encodeURIComponent(selector) + "/" + entrypoint || !/\S/u.test(item.name) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(item.name) || !validAlias(item.alias) || Object.values(item).some(value => typeof value === "string" && value.includes("\0"))) decodeError(source);
  if (item.upstream && (item.kind !== "skill" || locator.type !== "notion_page" || !/\S/u.test(item.upstream.repo) || /[/\\\p{Cc}\p{Cf}\p{Cs}]/u.test(item.upstream.repo))) decodeError(source);
  return item;
}
function freshness(value: unknown, source: NotionSource): Json {
  if (!object(value) || !["default", "max_age", "refresh", "offline", "pinned"].includes(String(value.policy))) decodeError(source);
  if (value.policy !== "pinned") {
    if (typeof value.validated_at !== "string" || !Number.isFinite(Date.parse(value.validated_at)) || typeof value.age_ms !== "number" || !Number.isFinite(value.age_ms) || value.age_ms < 0 || typeof value.max_age_ms !== "number" || !Number.isFinite(value.max_age_ms) || value.max_age_ms < 0 || typeof value.stale !== "boolean") decodeError(source);
  }
  return value.policy === "pinned" ? { policy: "pinned" } : { policy: value.policy, validated_at: value.validated_at, age_ms: value.age_ms, max_age_ms: value.max_age_ms, stale: value.stale };
}
function policyArgs(policy: SourcePolicy | undefined, refresh?: boolean): string[] {
  if (refresh) return ["--refresh"];
  if (policy?.offline) return ["--offline"];
  return policy?.maxAge !== undefined ? ["--max-age", policy.maxAge] : [];
}

function sourceCommand(source: NotionSource): string[] {
  if (source.command) return typeof source.command === "string" ? [source.command] : source.command;
  const bundled = fileURLToPath(new URL("./ntn-skills.mjs", import.meta.url));
  try {
    const entry = existsSync(bundled) ? bundled : fileURLToPath(new URL("../dist/ntn-skills.mjs", import.meta.url));
    if (!existsSync(entry)) throw new SourceError("SOURCE_COMMAND_UNAVAILABLE", source.id);
    return [process.versions.bun ? "node" : process.execPath, entry];
  } catch { throw new SourceError("SOURCE_COMMAND_UNAVAILABLE", source.id); }
}

export function sourceFailureMessage(code: string): string {
  switch (code) {
    case "SOURCE_COMMAND_UNAVAILABLE": return "Cannot start the source CLI. Reinstall pi-context-broker or check the configured command and Node.js 22.22.3+ within 22.x or 24.20.0+.";
    case "NTN_UNAVAILABLE": return "The official Notion CLI could not complete a request. Check installation, network and authentication with ntn doctor, then run /context-broker doctor.";
    case "NTN_VERSION_UNSUPPORTED": return "Update the official Notion CLI (ntn) to a version supporting api --notion-version (verified with 0.22.12).";
    case "AUTH_REQUIRED": return "Authenticate with ntn login or configure the existing ntn-skills token; grant access to the selected Notion database.";
    case "ACCESS_DENIED": return "Grant the existing Notion connection read access to the selected database.";
    default: return "Check the source configuration and access, then run /context-broker refresh.";
  }
}

function checkNtnVersion(value: string, source: NotionSource): string {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)\b/.exec(value);
  if (!match || (Number(match[1]) === 0 && (Number(match[2]) < 22 || (Number(match[2]) === 22 && Number(match[3]) < 12)))) throw new SourceError("NTN_VERSION_UNSUPPORTED", source.id);
  return match[0].trim();
}
async function checkNtn(source: NotionSource, cwd: string, signal?: AbortSignal): Promise<void> {
  const command = [process.env.NTN_SKILLS_NTN_BIN ?? "ntn"];
  try {
    const version = await run(source, cwd, ["--version"], signal, command);
    checkNtnVersion(String(version.output), source);
    const help = await run(source, cwd, ["api", "--help"], signal, command);
    if (!String(help.output).includes("--notion-version")) throw new SourceError("NTN_VERSION_UNSUPPORTED", source.id);
  } catch (error) {
    if (error instanceof SourceError && error.code !== "SOURCE_COMMAND_UNAVAILABLE" && error.code !== "SOURCE_COMMAND_FAILED") throw error;
    throw new SourceError("NTN_UNAVAILABLE", source.id);
  }
}
export async function diagnoseNotionSource(source: NotionSource, cwd: string): Promise<{ version: string; authenticated: boolean }> {
  await checkNtn(source, cwd);
  const result = await run(source, cwd, ["ctl", "doctor"]);
  if (typeof result.ntn_version !== "string" || result.authentication !== "available") decodeError(source);
  return { version: checkNtnVersion(result.ntn_version, source), authenticated: true };
}
async function run(source: NotionSource, cwd: string, args: string[], signal?: AbortSignal, probeCommand?: string[], selectedPage?: string): Promise<Json> {
  if (signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  const command = probeCommand ?? sourceCommand(source);
  const { promise, resolve: resolveResult, reject } = Promise.withResolvers<Json>();
    const grouped = process.platform !== "win32";
    const child = spawn(command[0]!, [...command.slice(1), ...args], { cwd, shell: false, detached: grouped, stdio: ["ignore", "pipe", "pipe"], ...(source.requestTimeoutMs === undefined ? {} : { env: { ...process.env, NTN_SKILLS_REQUEST_TIMEOUT_MS: String(source.requestTimeoutMs) } }) });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: SourceError | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    function kill(sig: "SIGTERM" | "SIGKILL") {
      if (!child.pid) return;
      try { if (grouped) process.kill(-child.pid, sig); else child.kill(sig); }
      catch (error) { if (!object(error) || error.code !== "ESRCH") failure ??= new SourceError("SOURCE_PROCESS_TERMINATION_FAILED", source.id); }
    }
    function stop(code: string) {
      if (failure) return;
      failure = new SourceError(code, source.id);
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 250);
    }
    const abort = () => stop("SOURCE_CANCELLED");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) stop("SOURCE_RESPONSE_TOO_LARGE");
      else chunks.push(chunk);
    });
    // Drain stderr without retaining or exposing credentials, signed URLs or CLI diagnostics.
    child.stderr.resume();
    child.on("error", () => { failure ??= new SourceError("SOURCE_COMMAND_UNAVAILABLE", source.id); });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) { clearTimeout(killTimer); kill("SIGKILL"); }
      if (failure) { reject(failure); return; }
      if (probeCommand) {
        if (code !== 0) { reject(new SourceError("SOURCE_COMMAND_FAILED", source.id, code ?? undefined)); return; }
        resolveResult({ output: Buffer.concat(chunks).toString("utf8") });
        return;
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { reject(new SourceError(code === 0 ? "SOURCE_RESPONSE_INVALID" : "SOURCE_COMMAND_FAILED", source.id, code ?? undefined)); return; }
      if (!object(value)) { reject(new SourceError("SOURCE_RESPONSE_INVALID", source.id, code ?? undefined)); return; }
      if (value.ok === false && object(value.error)) {
        const details = object(value.error.details) ? value.error.details : undefined;
        const missingPage = typeof details?.path === "string" ? /^v1\/pages\/([0-9a-f-]+)$/i.exec(details.path)?.[1] : undefined;
        if (args[0] === "read" && value.error.code === "NOT_FOUND" && details?.notion_code === "object_not_found" && selectedPage && missingPage?.replaceAll("-", "").toLowerCase() === selectedPage.replaceAll("-", "").toLowerCase()) {
          reject(new ReferenceMiss(source.id)); return;
        }
        const externalCode = typeof value.error.code === "string" && CLI_CODES[value.error.code] === true ? value.error.code : "SOURCE_COMMAND_FAILED";
        reject(new SourceError(externalCode, source.id, code ?? undefined)); return;
      }
      if (code !== 0 || value.ok !== true) { reject(new SourceError("SOURCE_COMMAND_FAILED", source.id, code ?? undefined)); return; }
      resolveResult(value);
    });
  return promise;
}

async function cacheRoot(source: NotionSource, cwd: string): Promise<string> {
  const configured = source.cacheDir ?? join(homedir(), ".cache", "context-broker", "notion");
  const expanded = configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
  const selected = resolve(cwd, expanded);
  await mkdir(selected, { recursive: true, mode: 0o700 });
  if ((await lstat(selected)).isSymbolicLink()) throw new SourceError("SOURCE_CACHE_UNSAFE", source.id);
  return await realpath(selected);
}
async function privateDirectory(path: string, source: NotionSource): Promise<void> {
  // Refuse symlinked ancestors before creating a directory under a user-selected cache root.
  let cursor = resolve(path);
  while (true) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new SourceError("SOURCE_CACHE_UNSAFE", source.id); }
    catch (error) { if (!object(error) || error.code !== "ENOENT") throw error; }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== resolve(path)) throw new SourceError("SOURCE_CACHE_UNSAFE", source.id);
}

const CATALOG_CACHE_VERSION = 4;
const CATALOG_ORDER = /^[0-9]{20}$/;
const MAX_CATALOG_ORDER = "18446744073709551615";
type CatalogCache = { key: string; path: string; maxAgeMs: number };
async function catalogCache(source: NotionSource, cwd: string, signal?: AbortSignal): Promise<CatalogCache | undefined> {
  if (source.discovery?.offline) return undefined;
  try {
    const probeSignal = AbortSignal.timeout(5_000);
    const identity = await run(source, cwd, ["ctl", "cache", "identity", ...(source.database ? ["--database", source.database] : [])], signal ? AbortSignal.any([signal, probeSignal]) : probeSignal);
    if (typeof identity.identity !== "string" || !HASH.test(identity.identity) || !Number.isSafeInteger(identity.catalog_max_age_ms) || Number(identity.catalog_max_age_ms) < 0) return undefined;
    const key = createHash("sha256").update(JSON.stringify([CATALOG_CACHE_VERSION, identity.identity])).digest("hex");
    return { key, path: join(await cacheRoot(source, cwd), "catalogs-v4", key), maxAgeMs: Number(identity.catalog_max_age_ms) };
  } catch (error) {
    if (signal?.aborted) throw error;
    // Older/custom source commands can still discover normally without this optional capability.
    return undefined;
  }
}

async function latestCatalogOrder(directory: string, source: NotionSource, type: "file" | "directory"): Promise<string | undefined> {
  let latest: string | undefined;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!CATALOG_ORDER.test(entry.name) || entry.name === "00000000000000000000" || entry.name > MAX_CATALOG_ORDER) continue;
    if (type === "file" ? !entry.isFile() : !entry.isDirectory()) throw new SourceError("SOURCE_CACHE_UNSAFE", source.id);
    if (latest === undefined || entry.name > latest) latest = entry.name;
  }
  return latest;
}

async function reserveCatalogOrder(cache: CatalogCache, source: NotionSource, signal?: AbortSignal): Promise<string> {
  const claims = join(cache.path, "claims");
  await privateDirectory(claims, source);
  while (true) {
    if (signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
    const latest = await latestCatalogOrder(claims, source, "file");
    const order = ((latest === undefined ? 0n : BigInt(latest)) + 1n).toString().padStart(20, "0");
    if (order > MAX_CATALOG_ORDER) throw new SourceError("SOURCE_STORAGE_ERROR", source.id);
    try {
      await writeFile(join(claims, order), "", { flag: "wx", mode: 0o600 });
      return order;
    } catch (error) {
      if (!object(error) || error.code !== "EEXIST") throw error;
    }
  }
}

async function readCatalog(cache: CatalogCache, source: NotionSource): Promise<Json | undefined> {
  const published = join(cache.path, "published");
  await privateDirectory(published, source);
  const order = await latestCatalogOrder(published, source, "directory");
  if (order === undefined) return undefined;
  const directory = join(published, order);
  await privateDirectory(directory, source);
  const path = join(directory, "receipt.json");
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new SourceError("SOURCE_CACHE_UNSAFE", source.id);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) return undefined;
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  // The maximum directory remains an ordering fence even when its receipt is invalid.
  return object(value) && value.version === CATALOG_CACHE_VERSION && value.key === cache.key && value.order === order && object(value.result) && typeof value.indexId === "string" && UUID.test(value.indexId) ? value : undefined;
}

export async function discoverNotionSource(source: NotionSource, cwd: string, options: Options = {}): Promise<NotionDirectory> {
  const selectedView = options.view !== undefined || options.defaultView === true;
  // The CLI owns View observations. Never store a filtered directory under the full-library key.
  const cache = selectedView ? undefined : await catalogCache(source, cwd, options.signal);
  let saved: { result: Json; indexId: string } | undefined;
  if (cache && !options.refresh) {
    try {
      const value = await readCatalog(cache, source);
      if (value) {
        const result = value.result as Json;
        const observed = freshness(result.freshness, source);
        const maxAge = source.discovery?.maxAge;
        const duration = maxAge === undefined ? cache.maxAgeMs : maxAge === "0" ? 0 : Number(maxAge.slice(0, -1)) * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[maxAge.at(-1)!] ?? 0);
        const age = Date.now() - Date.parse(String(observed.validated_at));
        if (age >= 0 && (options.stale || age < duration)) {
          saved = { result: { ...result, freshness: { ...observed, age_ms: age, max_age_ms: duration, stale: age >= duration } }, indexId: value.indexId as string };
        }
      }
    } catch (error) {
      if (options.signal?.aborted || error instanceof SourceError && error.code === "SOURCE_CACHE_UNSAFE") throw error;
      // An absent or invalid derived index is rebuilt through the authoritative CLI.
    }
  }
  const order = !saved && cache ? await reserveCatalogOrder(cache, source, options.signal) : undefined;
  if (!saved && !source.command && !source.discovery?.offline) await checkNtn(source, cwd, options.signal);
  const result = saved?.result ?? await run(source, cwd, ["list", ...(source.database ? ["--database", source.database] : []), ...(options.view ? ["--view", options.view] : options.defaultView ? ["--default-view"] : []), ...policyArgs(source.discovery, options.refresh)], options.signal);
  const scope = text(result.scope, source);
  if (!HASH.test(scope) || "skills" in result || !Array.isArray(result.records) || !Array.isArray(result.databases) || result.count !== result.records.length || typeof result.fetched_at !== "number" || !Number.isSafeInteger(result.fetched_at) || result.fetched_at < 0) decodeError(source);
  const observedFreshness = freshness(result.freshness, source);
  const databases = result.databases.map((value) => {
    if (!object(value) || typeof value.database_id !== "string" || !UUID.test(value.database_id) || typeof value.title !== "string" || typeof value.alias !== "string" || (value.role !== undefined && value.role !== "content" && value.role !== "upstream") || !Array.isArray(value.data_source_ids) || !value.data_source_ids.every((id) => typeof id === "string" && UUID.test(id))) decodeError(source);
    return { id: value.database_id, alias: value.alias, role: value.role ?? "content", sources: value.data_source_ids as string[] };
  });
  const coverage = result.coverage;
  if (!object(coverage) || !["search_and_registered", "explicit_database", "explicit_view"].includes(String(coverage.method)) || typeof coverage.exhaustive !== "boolean" || typeof coverage.search_index_limited !== "boolean" || !Array.isArray(coverage.queried_data_sources) || !coverage.queried_data_sources.every((id) => typeof id === "string" && UUID.test(id)) || !Array.isArray(coverage.failed_sources)) decodeError(source);
  for (const failed of coverage.failed_sources) if (!object(failed) || typeof failed.id !== "string" || typeof failed.code !== "string") decodeError(source);
  if (coverage.failed_sources.length && coverage.exhaustive) decodeError(source);
  const failures: SourceFailure[] = coverage.failed_sources.length ? [{ sourceId: source.id, namespace: source.namespace ?? source.id, type: "notion", code: "CATALOG_INCOMPLETE", blocking: false, message: `${coverage.failed_sources.length} records or sources could not be discovered; exact returned records remain available.` }] : [];
  const selected = selectedView ? parseViewSelection(result, source) : undefined;
  const selectedDatabases = source.database === undefined ? undefined : UUID.test(source.database)
    ? [source.database.replaceAll("-", "").toLowerCase()]
    : databases.filter(database => database.role === "content" && database.alias === source.database).map(database => database.id.replaceAll("-", "").toLowerCase());
  if (selectedDatabases && selectedDatabases.length !== 1) decodeError(source);
  const skills = result.records.map((value) => contentRecord(value, source));
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const item of skills) {
    const page = createHash("sha256").update(item.id).digest("hex");
    const locator = item.locator;
    if (locator.type === "local") decodeError(source);
    const role = locator.type === "notion_subscription" ? "upstream" : "content";
    const target = locator.type === "notion_subscription" ? locator.target_database_id : locator.database_id;
    if (seen.has(page) || !coverage.queried_data_sources.includes(locator.data_source_id) || !databases.some(database => database.id === locator.database_id && database.role === role && database.sources.includes(locator.data_source_id)) || (selectedDatabases && !selectedDatabases.includes(target.replaceAll("-", "").toLowerCase()))) decodeError(source);
    seen.add(page);
    counts.set(item.alias, (counts.get(item.alias) ?? 0) + 1);
  }
  const indexId = saved?.indexId ?? randomUUID();
  const index = join(await cacheRoot(source, cwd), "scopes", scope, "indexes", indexId);
  if (saved) {
    const info = await lstat(index).catch(() => undefined);
    if (!info?.isDirectory() || await realpath(index) !== resolve(index)) return discoverNotionSource(source, cwd, { ...options, refresh: true });
  } else await privateDirectory(index, source);
  const records: SkillRecord[] = [];
  for (const item of skills) {
    const page = createHash("sha256").update(item.id).digest("hex");
    const dir = join(index, page);
    if (!saved) await privateDirectory(dir, source);
    const path = join(dir, item.entrypoint);
    const namespace = source.namespace ?? source.id;
    const selector = item.locator.type === "notion_page" ? item.locator.page_id : item.locator.type === "notion_subscription" ? item.locator.subscription_id : item.id;
    const name = `${item.alias}${counts.get(item.alias)! > 1 || !coverage.exhaustive ? `@${selector.replaceAll("-", "")}` : ""}`;
    const token = `${namespace}/${name}`;
    const hostName = name.replace(/[^a-z0-9-]/g, "-");
    const stub = `---\nname: ${JSON.stringify(hostName)}\ndescription: ${JSON.stringify(item.description)}\n---\n`;
    if (!saved) await writeFile(path, stub, { flag: "wx", mode: 0o600 });
    records.push({ ...item, source: "notion", aliases: [], autoloadEnabled: item.kind !== "prompt", normalizedName: item.alias, normalizedAliases: [], normalizedDescription: normalizeKey(item.description), path, metadataIndexPath: path, sourceId: source.id, token, selectionToken: `${name}@${namespace}`, sourceScope: scope, freshness: observedFreshness, coverage });
  }
  if (!saved && cache && order && (await catalogCache(source, cwd, options.signal))?.key === cache.key) {
    const published = join(cache.path, "published");
    await privateDirectory(published, source);
    const pending = join(cache.path, `.pending-${indexId}`);
    await privateDirectory(pending, source);
    const receipt = JSON.stringify({ version: CATALOG_CACHE_VERSION, key: cache.key, order, result, indexId });
    if (Buffer.byteLength(receipt) > 16 * 1024 * 1024) throw new SourceError("SOURCE_RESPONSE_TOO_LARGE", source.id);
    await writeFile(join(pending, "receipt.json"), receipt, { flag: "wx", mode: 0o600 });
    if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
    await rename(pending, join(published, order));
  }
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  return Object.assign(attachList(records, source, observedFreshness), { failures, ...(selectedView ? { view: selected ?? null } : {}) });
}

const ViewMetadataSchema = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String, database_id: Schema.String, data_source_id: Schema.String, url: Schema.String });
function parseView(value: unknown, source: NotionSource): NotionView {
  let view: NotionView;
  try { view = Schema.decodeUnknownSync(ViewMetadataSchema)(value); } catch { return decodeError(source); }
  if (![view.id, view.database_id, view.data_source_id].every(id => UUID.test(id))) decodeError(source);
  return view;
}
function parseViewSelection(result: Json, source: NotionSource): NotionView | null {
  if (result.view === null && result.view_selection === "none" && result.count === 0) return null;
  if (!["first", "explicit"].includes(String(result.view_selection))) decodeError(source);
  return parseView(result.view, source);
}
export async function listNotionViews(source: NotionSource, cwd: string, signal?: AbortSignal): Promise<NotionView[]> {
  const result = await run(source, cwd, ["views", ...(source.database ? ["--database", source.database] : []), ...policyArgs(source.discovery)], signal);
  if (!Array.isArray(result.views) || result.count !== result.views.length) decodeError(source);
  return result.views.map(view => parseView(view, source));
}

function attachList(records: SkillRecord[], source: NotionSource, value: Json): SkillRecord[] & { list: NotionListObservation } {
  const policy = String(value.policy) as NotionListObservation["policy"];
  const list: NotionListObservation = policy === "pinned"
    ? { sourceId: source.id, policy }
    : { sourceId: source.id, policy, validatedAt: String(value.validated_at), ageMs: Number(value.age_ms), maxAgeMs: Number(value.max_age_ms), stale: value.stale === true };
  Object.defineProperty(records, "list", { value: list });
  return records as SkillRecord[] & { list: NotionListObservation };
}

function portablePath(value: unknown, source: NotionSource): string {
  const path = text(value, source);
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(path)) decodeError(source);
  return path;
}
async function inventory(directory: string, source: NotionSource): Promise<Array<{ path: string; bytes: number; hash: string }>> {
  const items: Array<{ path: string; bytes: number; hash: string }> = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new SourceError("SOURCE_CACHE_UNSAFE", source.id);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const path = relative(directory, file).split(sep).join("/");
        if (path === ".broker-snapshot.json") continue;
        const bytes = await readFile(file);
        items.push({ path, bytes: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") });
      } else throw new SourceError("SOURCE_CACHE_UNSAFE", source.id);
    }
  }
  await walk(directory);
  return items.sort((a, b) => a.path.localeCompare(b.path));
}

export async function loadNotionSkill(record: SkillRecord, source: NotionSource, cwd: string, options: Options = {}): Promise<SkillRecord> {
  if (record.sourceId !== source.id || !record.id || !record.ref || !record.locator || record.locator.type === "local" || !record.sourceScope || !HASH.test(record.sourceScope)) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  const selected = contentRecord({ id: record.id, kind: record.kind, locator: record.locator, name: record.name, alias: record.alias, description: record.description, default_context: record.default_context, entrypoint: record.entrypoint, ref: record.ref }, source);
  const sameIdentity = (item: ContentRecord) => item.id === selected.id && item.kind === selected.kind && isDeepStrictEqual(item.locator, selected.locator) && item.entrypoint === selected.entrypoint && item.ref === selected.ref;
  const read = await run(source, cwd, ["read", record.ref, ...(source.database ? ["--database", source.database] : []), ...policyArgs(source.activation)], options.signal, undefined, record.locator.type === "notion_page" ? record.locator.page_id : undefined);
  if ("skill" in read || "skill_name" in read) decodeError(source);
  const current = contentRecord(read.record, source);
  const snapshot = text(read.snapshot_id, source);
  const version = text(read.version_id, source);
  // Names and aliases may change after selection; the exact page, scope and entry remain authoritative.
  if (!sameIdentity(current) || !SNAPSHOT.test(snapshot) || read.scope !== record.sourceScope) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  if (typeof read.content !== "string" || read.has_more !== false || !object(read.range) || typeof read.range.total_lines !== "number" || !Number.isSafeInteger(read.range.total_lines) || read.range.total_lines < 1 || read.range.start !== 1 || read.range.end !== read.range.total_lines || read.path !== current.entrypoint || read.entrypoint !== current.entrypoint || read.ref !== `${current.ref}?snapshot=${snapshot}`) decodeError(source);
  const observedFreshness = freshness(read.freshness, source);
  const parent = join(await cacheRoot(source, cwd), "scopes", record.sourceScope, "records", createHash("sha256").update(current.id).digest("hex"), "snapshots");
  await privateDirectory(parent, source);
  const destination = join(parent, snapshot);
  try {
    await lstat(destination);
    await privateDirectory(destination, source);
    let receipt: unknown;
    try { receipt = JSON.parse(await readFile(join(destination, ".broker-snapshot.json"), "utf8")); }
    catch { throw new SourceError("SOURCE_OUTPUT_CONFLICT", source.id); }
    if (object(receipt) && receipt.version === 2) {
      // v2 cached the source projection as if it were the host snapshot. Rebuild once;
      // retain the old directory for inspection instead of interpreting its bytes.
      try { await rename(destination, join(parent, `.invalidated-${snapshot}-${randomUUID()}`)); }
      catch (error) { if (!object(error) || error.code !== "ENOENT") throw error; }
    } else {
      if (!object(receipt) || receipt.version !== 3) throw new SourceError("SOURCE_CACHE_VERSION_UNSUPPORTED", source.id);
      if (receipt.projection !== "snapshot" || receipt.scope !== record.sourceScope || !isDeepStrictEqual(receipt.record, current) || receipt.snapshot !== snapshot || receipt.notionVersion !== version || typeof receipt.contentId !== "string" || !HASH.test(receipt.contentId) || !Array.isArray(receipt.files)) throw new SourceError("SOURCE_OUTPUT_CONFLICT", source.id);
      const entry = portablePath(receipt.entry, source);
      if (entry !== current.entrypoint || await readFile(join(destination, entry), "utf8") !== read.content) throw new SourceError("SOURCE_OUTPUT_CONFLICT", source.id);
      if (!isDeepStrictEqual(await inventory(destination, source), receipt.files)) throw new SourceError("SOURCE_OUTPUT_CONFLICT", source.id);
      if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
      const path = join(destination, entry);
      return { ...record, ...current, upstream: current.upstream, path, body: read.content, normalizedName: current.alias, normalizedDescription: normalizeKey(current.description), snapshotId: snapshot, versionId: version, freshness: observedFreshness };
    }
  } catch (error) { if (!object(error) || error.code !== "ENOENT") throw error; }
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  const stage = join(parent, `.stage-${randomUUID()}`);
  const exported = await run(source, cwd, ["export", snapshot, "--projection", "snapshot", "--format", "directory", "--output", stage], options.signal);
  if ("skill" in exported || "skill_name" in exported) decodeError(source);
  const exportedRecord = contentRecord(exported.record, source);
  if (exported.projection !== "snapshot") throw new SourceError("SOURCE_EXPORT_PROJECTION_INVALID", source.id);
  if (!sameIdentity(exportedRecord) || !isDeepStrictEqual(exportedRecord, current) || exported.entrypoint !== current.entrypoint || exported.ref !== read.ref || exported.snapshot_id !== snapshot || exported.version_id !== version || exported.scope !== record.sourceScope || exported.operation !== "export" || exported.format !== "directory" || exported.output !== stage || typeof exported.reused !== "boolean" || typeof exported.content_id !== "string" || !HASH.test(exported.content_id) || !Array.isArray(exported.files)) decodeError(source);
  if (freshness(exported.freshness, source).policy !== "pinned") decodeError(source);
  const main = portablePath(exported.main_path, source);
  if (main !== current.entrypoint) decodeError(source);
  const expected = exported.files.map((value) => {
    if (!object(value) || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || typeof value.hash !== "string" || !HASH.test(value.hash)) decodeError(source);
    const path = portablePath(value.path, source);
    const role = path === main ? "entrypoint" : path === ".ntn-skills.json" ? "manifest" : path === "ntn-skills-source.zip" ? "source_bundle" : "resource";
    if (value.role !== role) decodeError(source);
    return { path, bytes: value.bytes, hash: value.hash };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const expectedPaths = new Set(expected.map((item) => item.path));
  if (expectedPaths.size !== expected.length || !expectedPaths.has(main) || !expectedPaths.has(".ntn-skills.json") || expectedPaths.has(".broker-snapshot.json")) decodeError(source);
  await privateDirectory(stage, source);
  const actual = await inventory(stage, source);
  if (!isDeepStrictEqual(actual, expected)) throw new SourceError("SOURCE_EXPORT_INCOMPLETE", source.id);
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(join(stage, ".ntn-skills.json"), "utf8")); }
  catch { throw new SourceError("SOURCE_EXPORT_INCOMPLETE", source.id); }
  if (!object(manifest) || manifest.format !== "ntn-skills" || manifest.version !== 2) throw new SourceError("SOURCE_PORTABLE_FORMAT_UNSUPPORTED", source.id);
  if (manifest.kind !== current.kind || manifest.main !== main || manifest.name !== current.name || manifest.description !== current.description) decodeError(source);
  const entry = main;
  if (await readFile(join(stage, entry), "utf8") !== read.content) throw new SourceError("SOURCE_EXPORT_INCOMPLETE", source.id);
  const files = actual;
  const receipt = { version: 3, projection: "snapshot", scope: record.sourceScope, record: current, snapshot, notionVersion: version, contentId: exported.content_id, entry, files };
  await writeFile(join(stage, ".broker-snapshot.json"), JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  try { await rename(stage, destination); }
  catch (error) {
    if (!object(error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error;
    // Another process can publish the same immutable snapshot. Its verified bytes converge.
    await privateDirectory(destination, source);
    let savedReceipt: unknown;
    try { savedReceipt = JSON.parse(await readFile(join(destination, ".broker-snapshot.json"), "utf8")); }
    catch { throw new SourceError("SOURCE_OUTPUT_CONFLICT", source.id); }
    if (!isDeepStrictEqual(savedReceipt, receipt) || !isDeepStrictEqual(await inventory(destination, source), files)) throw new SourceError("SOURCE_OUTPUT_CONFLICT", source.id);
    await rename(stage, join(parent, `.retained-${basename(stage).slice(1)}`));
  }
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  const path = join(destination, entry);
  const body = await readFile(path, "utf8");
  return { ...record, ...current, upstream: current.upstream, path, body, normalizedName: current.alias, normalizedDescription: normalizeKey(current.description), snapshotId: snapshot, versionId: version, freshness: observedFreshness };
}
