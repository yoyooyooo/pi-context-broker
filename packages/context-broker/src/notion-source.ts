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
import { parseNativeReference, type NativeFileBinding } from "./native-reference";
import { decodePreparedGraph, preparationFailureDetails, type PreparationPurpose, type PreparationBinding, type PreparedHostGraph } from "./prepare-protocol";
import { sharedSkillId, validSharedIdentity } from "./shared-skill-identity";
import type { PrefetchBudget, PrefetchOutcome, PrefetchPlan } from "./prefetch-policy";
import { publishNotionEntry, materializeNotionEntryFile, materializeNotionResourceBatch, publishNotionResourceFile } from "./notion-entry";
import { consumeNotionSdk, readNotionSdk, readNotionResourcesSdk, listNotionCatalogSdk, resolveNotionCatalogReferenceSdk, listNotionFilesSdk, supportsNotionSdkReadOutputProof, supportsNotionSdkCatalogDirectory, parseNotionSdkDuration, NotionSdkError } from "./notion-sdk";
import { DEFAULT_RESOURCE_READ_BUDGET, type FixedResourceRead, type ResourceReadBatch, type ResourceReadFileIdentity, type ResourceReadWireFile } from "./resource-read-types";
import type { ContentRecord, NotionDirectory, NotionDirectorySelection, NotionDirectoryOutcome, NotionListObservation, NotionView, SkillRecord, SourceConfig, SourcePolicy, SourceFailure } from "./types";

type NotionSource = Extract<SourceConfig, { type: "notion" }>;
type Options = { signal?: AbortSignal; refresh?: boolean; stale?: boolean; view?: string; defaultView?: boolean; snapshotId?: string };
type Json = Record<string, unknown>;
const PageLocator = Schema.Struct({ type: Schema.Literal("notion_page"), page_id: Schema.String, database_id: Schema.String, data_source_id: Schema.String });
const SubscriptionLocator = Schema.Struct({ type: Schema.Literal("notion_subscription"), subscription_id: Schema.String, database_id: Schema.String, data_source_id: Schema.String, target_database_id: Schema.String });
const SharedLocator = Schema.Struct({ type: Schema.Literal("shared_skill"), page_id: Schema.String, database_id: Schema.String, data_source_id: Schema.String, library_id: Schema.String, skill_id: Schema.String });
const ContentSchema = Schema.Struct({ id: Schema.String, kind: Schema.Literals(["skill", "router", "prompt"]), locator: Schema.Union([PageLocator, SubscriptionLocator, SharedLocator]), name: Schema.String, alias: Schema.String, description: Schema.String, default_context: Schema.Boolean, enabled: Schema.optional(Schema.Boolean), entrypoint: Schema.String, ref: Schema.String, upstream: Schema.optional(Schema.Struct({ repo: Schema.String })) });
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SNAPSHOT = /^s_[0-9a-f]{64}$/;
const CLI_CODES: Record<string, true | undefined> = Object.fromEntries("SKILL_NOT_FOUND SKILL_AMBIGUOUS INVALID_SKILL_NAME CATALOG_INCOMPLETE AUTH_REQUIRED ACCESS_DENIED NOTION_UNAVAILABLE NOTION_REQUEST_FAILED NOTION_QUEUE_FULL NOTION_SCHEDULER_UNAVAILABLE RATE_LIMITED CONFIG_ERROR SNAPSHOT_MISSING SNAPSHOT_CONFLICT DATABASE_NOT_FOUND DATABASE_AMBIGUOUS OUTPUT_CONFLICT MARKDOWN_INCOMPLETE INVALID_REFERENCES REFERENCE_PATH_CONFLICT REFERENCE_NOT_FOUND UNSUPPORTED_FILE INPUT_FAILED INVALID_INPUT FILE_TOO_LARGE FILE_NOT_FOUND BINARY_FILE INVALID_REF INVALID_PATH INVALID_RANGE INVALID_ARGUMENT INVALID_ARCHIVE INVALID_SKILL ARCHIVE_TOO_LARGE STATE_CORRUPT STORAGE_ERROR OUTPUT_FAILED CACHE_MISSING CACHE_SCOPE_UNAVAILABLE CACHE_INCOMPLETE INVALID_SNAPSHOT INVALID_RESPONSE NOT_SKILLS_DATABASE DOWNLOAD_FAILED CRYPTO_ERROR INVALID_SOURCE SOURCE_AMBIGUOUS INTERNAL_ERROR INVALID_VIEW VIEW_SCOPE_MISMATCH VIEW_INCOMPLETE VIEW_QUERY_EXPIRED VIEW_MEMBER_UNAVAILABLE NOT_FOUND CONTENT_DISABLED SHARED_PROFILE_INVALID SHARED_PROFILE_SCOPE SHARED_PROFILE_NOT_FOUND SHARED_PROFILE_BASELINE_MISSING SHARED_PROFILE_CONFLICT SHARED_PROFILE_PENDING SHARED_PROFILE_PENDING_CONFLICT SHARED_PROFILE_UNRESOLVED SHARED_PROFILE_STALE SHARED_PROFILE_DISABLED".split(" ").map((code) => [code, true as const]));

export class SourceError extends Error {
  readonly code: string;
  readonly sourceId: string;
  readonly exitCode?: number;
  readonly details?: ReturnType<typeof preparationFailureDetails>;
  constructor(code: string, sourceId: string, exitCode?: number, details?: ReturnType<typeof preparationFailureDetails>) {
    super(`context-broker source operation failed (${code})`);
    this.name = "SourceError";
    this.code = code;
    this.sourceId = sourceId;
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** Validated discovery choices only; none of these records proves body delivery. */
export class SourceReferenceAmbiguity extends SourceError {
  readonly #candidates: readonly { record: SkillRecord; ref: string }[];
  constructor(sourceId: string, candidates: readonly { record: SkillRecord; ref: string }[], message?: string) {
    super("SKILL_AMBIGUOUS", sourceId);
    this.name = "SourceReferenceAmbiguity";
    this.#candidates = candidates;
    if (message !== undefined) this.message = message;
  }
  get candidates() { return this.#candidates; }
}

/** A target lookup miss, distinct from missing resources or unavailable sources. */
export class ReferenceMiss extends Error {
  constructor(readonly sourceId: string, readonly recordId?: string) { super("Content reference is unavailable"); this.name = "ReferenceMiss"; }
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
  const page = locator.type === "notion_subscription" ? locator.subscription_id : locator.page_id;
  const canonical = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const entrypoint = { skill: "SKILL.md", router: "ROUTER.md", prompt: "PROMPT.md" }[item.kind];
  const identity = locator.type === "shared_skill" ? sharedSkillId(locator.library_id, locator.skill_id) : locator.type + ":" + page;
  if (identity === undefined || locator.type === "shared_skill" && typeof item.enabled !== "boolean") decodeError(source);
  const selector = locator.type === "shared_skill" ? identity : locator.type === "notion_page" ? page : "upstream:" + page;
  if (!canonical.test(page) || !canonical.test(locator.database_id) || !canonical.test(locator.data_source_id) || (locator.type === "notion_subscription" && (!canonical.test(locator.target_database_id) || item.kind !== "router")) || item.id !== identity || item.entrypoint !== entrypoint || item.ref !== "skill://" + encodeURIComponent(selector) + "/" + entrypoint || !/\S/u.test(item.name) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(item.name) || !validAlias(item.alias) || Object.values(item).some(value => typeof value === "string" && value.includes("\0"))) decodeError(source);
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

async function sdkFreshness(source: NotionSource, refresh?: boolean) {
  if (refresh) return { policy: "refresh" };
  if (source.activation?.offline) return { policy: "offline" };
  const duration = source.activation?.maxAge;
  if (duration === undefined) return { policy: "default" };
  let max_age_ms: number;
  try { max_age_ms = await parseNotionSdkDuration(duration); }
  catch (error) { throw sdkFailure(error, source, "prepare"); }
  return { policy: "max_age", max_age_ms };
}
function sdkOptions(source: NotionSource, cwd: string, signal?: AbortSignal) {
  return { sourceId: source.id, database: source.database, cwd, signal, env: { ...process.env,
    ...(source.requestTimeoutMs === undefined ? {} : { NTN_SKILLS_REQUEST_TIMEOUT_MS: String(source.requestTimeoutMs) }) } };
}
function sdkFailure(error: unknown, source: NotionSource, operation: "prepare" | "read" | "list", signal?: AbortSignal, selected?: SkillRecord): Error {
  if (signal?.aborted || object(error) && error.code === "CANCELLED") return new SourceError("SOURCE_CANCELLED", source.id);
  if (error instanceof NotionSdkError) return new SourceError(error.code, source.id);
  if (!object(error)) return new SourceError("SOURCE_SDK_FAILED", source.id);
  const details = object(error.details) ? error.details : undefined;
  const preparation = object(details?.preparation) ? details.preparation : undefined;
  const rootOnlyFailure = operation === "prepare" && preparation?.status === "failed" && Array.isArray(preparation.required) && preparation.required.length === 0
    && Array.isArray(preparation.nodes) && preparation.nodes.length === 1 && preparation.nodes.every(node => object(node) && node.state === "failed"
      && Array.isArray(node.roles) && node.roles.length === 1 && node.roles[0] === "root");
  const missingPage = typeof details?.path === "string" ? /^v1\/pages\/([0-9a-f-]+)$/i.exec(details.path)?.[1] : undefined;
  const selectedPage = selected?.locator?.type === "shared_skill" || selected?.locator?.type === "notion_page" ? selected.locator.page_id : undefined;
  if ((operation === "read" || rootOnlyFailure) && error.code === "NOT_FOUND" && details?.notion_code === "object_not_found"
    && selectedPage && missingPage?.replaceAll("-", "").toLowerCase() === selectedPage.replaceAll("-", "").toLowerCase()) return new ReferenceMiss(source.id, selected?.id);
  const code = typeof error.code === "string" && (CLI_CODES[error.code] === true
    || /^RESOURCE_[A-Z_]+$/.test(error.code) || error.code === "SNAPSHOT_NOT_MATERIALIZED"
    || operation === "prepare" && /^(?:PREPARE_[A-Z_]+|CONSUME_[A-Z_]+|SHARED_[A-Z_]+|NOTION_PREFETCH_(?:DEFERRED|WRITE_FORBIDDEN))$/.test(error.code)) ? error.code : "SOURCE_SDK_FAILED";
  return new SourceError(code, source.id, undefined, operation === "prepare" ? preparationFailureDetails(details) : undefined);
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
    case "SOURCE_SDK_UNAVAILABLE":
    case "SOURCE_SDK_INCOMPATIBLE": return "The bundled ntn-skills SDK is missing or incompatible. Reinstall the complete pi-context-broker package.";
    case "NOTION_UNAVAILABLE": return "The direct Notion API request could not complete. Check the connection and run /context-broker doctor.";
    case "SOURCE_PROTOCOL_UNSUPPORTED": return "Update the source CLI to a build with the direct Notion API doctor contract.";
    case "AUTH_REQUIRED": return "Configure the ntn-skills token with ctl config set-token --stdin or NOTION_API_TOKEN; grant access to the selected Notion database.";
    case "NOTION_QUEUE_FULL": return "The shared Notion request queue is full. Let the current work finish, then retry this read.";
    case "NOTION_SCHEDULER_UNAVAILABLE": return "The shared Notion request scheduler is unavailable. Check the local scheduler state and run /context-broker doctor.";
    case "ACCESS_DENIED": return "Grant the existing Notion connection read access to the selected database.";
    case "CONTENT_DISABLED": return "The Skill is disabled (Enabled=false) in Notion. This is not a source connection failure. Enable it before retrying the exact read; catalog metadata may remain cached until refreshed.";
    default: return "Check the source configuration and access, then run /context-broker refresh.";
  }
}

export async function diagnoseNotionSource(source: NotionSource, cwd: string): Promise<{ version: string; authenticated: boolean }> {
  const result = await run(source, cwd, ["ctl", "doctor", ...(source.database ? ["--database", source.database] : [])]);
  if (result.transport !== "direct_http" || result.notion_api_version !== "2026-03-11") throw new SourceError("SOURCE_PROTOCOL_UNSUPPORTED", source.id);
  if (result.authentication !== "available") decodeError(source);
  return { version: result.notion_api_version, authenticated: true };
}
async function run(source: NotionSource, cwd: string, args: string[], signal?: AbortSignal, selectedPage?: string, selectedRecord?: string): Promise<Json> {
  if (signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  const command = sourceCommand(source);
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
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { reject(new SourceError(code === 0 ? "SOURCE_RESPONSE_INVALID" : "SOURCE_COMMAND_FAILED", source.id, code ?? undefined)); return; }
      if (!object(value)) { reject(new SourceError("SOURCE_RESPONSE_INVALID", source.id, code ?? undefined)); return; }
      if (value.ok === false && object(value.error)) {
        const details = object(value.error.details) ? value.error.details : undefined;
        const missingPage = typeof details?.path === "string" ? /^v1\/pages\/([0-9a-f-]+)$/i.exec(details.path)?.[1] : undefined;
        const preparation = object(details?.preparation) ? details.preparation : undefined;
        const rootOnlyFailure = args[0] === "prepare" && preparation?.status === "failed" && Array.isArray(preparation.required) && preparation.required.length === 0
          && Array.isArray(preparation.nodes) && preparation.nodes.length === 1 && preparation.nodes.every(node => object(node) && node.state === "failed"
            && Array.isArray(node.roles) && node.roles.length === 1 && node.roles[0] === "root");
        if ((args[0] === "read" || rootOnlyFailure) && value.error.code === "NOT_FOUND" && details?.notion_code === "object_not_found" && selectedPage && missingPage?.replaceAll("-", "").toLowerCase() === selectedPage.replaceAll("-", "").toLowerCase()) {
          reject(new ReferenceMiss(source.id, selectedRecord)); return;
        }
        const externalCode = typeof value.error.code === "string" && (CLI_CODES[value.error.code] === true
          || args[0] === "prepare" && /^(?:PREPARE_[A-Z_]+|SHARED_[A-Z_]+|NOTION_PREFETCH_(?:DEFERRED|WRITE_FORBIDDEN))$/.test(value.error.code)) ? value.error.code : "SOURCE_COMMAND_FAILED";
        reject(new SourceError(externalCode, source.id, code ?? undefined, args[0] === "prepare" ? preparationFailureDetails(details) : undefined)); return;
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
CLI_CODES.LIST_CURSOR_STALE = true;
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

async function commandCatalog(source: NotionSource, cwd: string, selectors: string[], options: Options): Promise<Json> {
  const first = await run(source, cwd, ["list", ...selectors, ...policyArgs(source.discovery, options.refresh)], options.signal);
  // Older explicit commands return one full directory. New bounded lists must
  // finish their continuation before they can become a full-library cache entry.
  if (first.has_more === undefined) {
    if (first.total_count !== undefined || first.next_cursor !== undefined) decodeError(source);
    return first;
  }
  const records: unknown[] = [], cursors = new Set<string>();
  let page = first, bytes = 0;
  const identity = (value: Json) => [value.fetched_at, value.databases, value.coverage, value.view, value.view_selection,
    value.capability_directory, object(value.profile) ? [value.profile.library_id, value.profile.library_entry,
      value.profile.profile_id, value.profile.revision_id, value.profile.selection] : value.profile];
  while (true) {
    if (page.scope !== first.scope) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
    if (!isDeepStrictEqual(identity(page), identity(first)) || !Array.isArray(page.records) || page.count !== page.records.length
      || !Number.isSafeInteger(page.total_count) || Number(page.total_count) < 0 || page.total_count !== first.total_count
      || typeof page.has_more !== "boolean") decodeError(source);
    bytes += Buffer.byteLength(JSON.stringify(page.records));
    if (bytes > 16 * 1024 * 1024) throw new SourceError("SOURCE_RESPONSE_TOO_LARGE", source.id);
    records.push(...page.records);
    if (records.length > Number(first.total_count)) decodeError(source);
    if (!page.has_more) {
      if (records.length !== first.total_count || page.next_cursor !== null) decodeError(source);
      return { ...first, records, count: records.length, has_more: false, next_cursor: null };
    }
    if (!page.records.length || records.length >= Number(first.total_count) || typeof page.next_cursor !== "string"
      || !page.next_cursor || page.next_cursor.length > 4096 || page.next_cursor.includes("\0") || cursors.has(page.next_cursor)) decodeError(source);
    cursors.add(page.next_cursor);
    // Continue the same core observation. Refreshing every page can mix versions.
    page = await run(source, cwd, ["list", ...selectors, "--offline", "--cursor", page.next_cursor], options.signal);
  }
}

async function catalogPolicy(source: NotionSource, refresh?: boolean) {
  return refresh ? { refresh: true } : source.discovery?.offline ? { offline: true }
    : source.discovery?.maxAge === undefined ? {} : { maxAge: await parseNotionSdkDuration(source.discovery.maxAge) };
}

async function discoverNotionDirectory(source: NotionSource, cwd: string, options: Options, observed?: Json): Promise<{ catalog: Json; directory: NotionDirectory }> {
  if (source.profile_id !== undefined && (!validSharedIdentity(source.profile_id) || !source.database)) throw new SourceError("SOURCE_CONFIG_INVALID", source.id);
  if (options.view !== undefined && options.defaultView) throw new SourceError("SOURCE_CONFIG_INVALID", source.id);
  const selectedView = options.view !== undefined || options.defaultView === true;
  const selectedProfile = options.defaultView === true && options.view === undefined ? source.profile_id : undefined;
  // SDK discovery uses the core cache directly. The derived cache remains only
  // for explicit legacy commands; never put a filtered View under its full-library key.
  const cache = observed || selectedView || !source.command ? undefined : await catalogCache(source, cwd, options.signal);
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
  const result = observed ?? saved?.result ?? await (async () => {
    if (source.command) return commandCatalog(source, cwd, [...(source.database ? ["--database", source.database] : []), ...(options.view !== undefined ? ["--view", options.view] : options.defaultView ? ["--default-view"] : []), ...(selectedProfile === undefined ? [] : ["--profile", selectedProfile])], options);
    let value: unknown;
    try {
      const policy = await catalogPolicy(source, options.refresh);
      value = await listNotionCatalogSdk({ ...sdkOptions(source, cwd, options.signal), ...policy,
        ...(options.view !== undefined ? { view: options.view } : options.defaultView ? { defaultView: true } : {}),
        ...(selectedProfile === undefined ? {} : { profile: selectedProfile }) });
    } catch (error) { throw sdkFailure(error, source, "list", options.signal); }
    if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
    if (!object(value)) return decodeError(source);
    return value;
  })();
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
  if (selected && (coverage.method !== "explicit_view" ||
    !databases.some(database => database.role === "content" && database.id === selected.database_id && database.sources.includes(selected.data_source_id)) ||
    !coverage.queried_data_sources.includes(selected.data_source_id) ||
    selectedDatabases !== undefined && !selectedDatabases.includes(selected.database_id.replaceAll("-", "").toLowerCase()))) decodeError(source);
  if (!selectedView && (result.profile !== undefined || result.capability_directory === true || result.view !== undefined || coverage.method === "explicit_view")) decodeError(source);
  if (selectedProfile !== undefined || result.profile !== undefined) {
    const profile = result.profile;
    if (!options.defaultView || !object(profile) || !validSharedIdentity(profile.library_id) || !validSharedIdentity(profile.profile_id) ||
      selectedProfile !== undefined && profile.profile_id !== selectedProfile ||
      typeof profile.library_entry !== "string" || !UUID.test(profile.library_entry) ||
      !databases.some(database => database.role === "content" && database.id.replaceAll("-", "").toLowerCase() === (profile.library_entry as string).replaceAll("-", "").toLowerCase()) ||
      selectedDatabases !== undefined && !selectedDatabases.includes(profile.library_entry.replaceAll("-", "").toLowerCase()) ||
      typeof profile.revision_id !== "string" || !/^profile-[a-f0-9]{64}$/u.test(profile.revision_id) ||
      !["profile", "first"].includes(String(profile.selection)) || !["notion", "local_cache"].includes(String(profile.source)) ||
      result.capability_directory !== true) decodeError(source);
    freshness(profile.freshness, source);
  }
  const skills = result.records.map((value) => contentRecord(value, source));
  const seen = new Set<string>();
  const sharedPages = new Set<string>();
  const counts = new Map<string, number>();
  for (const item of skills) {
    const page = createHash("sha256").update(item.id).digest("hex");
    const locator = item.locator;
    if (locator.type === "local") decodeError(source);
    if (locator.type === "shared_skill") {
      if (sharedPages.has(locator.page_id)) decodeError(source);
      sharedPages.add(locator.page_id);
    }
    if (object(result.profile) && (locator.type !== "shared_skill" || locator.library_id !== result.profile.library_id || locator.database_id.replaceAll("-", "").toLowerCase() !== String(result.profile.library_entry).replaceAll("-", "").toLowerCase())) decodeError(source);
    const role = locator.type === "notion_subscription" ? "upstream" : "content";
    const target = locator.type === "notion_subscription" ? locator.target_database_id : locator.database_id;
    if (selected && (locator.database_id !== selected.database_id || locator.data_source_id !== selected.data_source_id)) decodeError(source);
    if (seen.has(page) || !coverage.queried_data_sources.includes(locator.data_source_id) || !databases.some(database => database.id === locator.database_id && database.role === role && database.sources.includes(locator.data_source_id)) || (selectedDatabases && !selectedDatabases.includes(target.replaceAll("-", "").toLowerCase()))) decodeError(source);
    seen.add(page);
    counts.set(item.alias, (counts.get(item.alias) ?? 0) + 1);
  }
  const indexId = saved?.indexId ?? randomUUID();
  const index = join(await cacheRoot(source, cwd), "scopes", scope, "indexes", indexId);
  if (saved) {
    const info = await lstat(index).catch(() => undefined);
    if (!info?.isDirectory() || await realpath(index) !== resolve(index)) return discoverNotionDirectory(source, cwd, { ...options, refresh: true });
  } else await privateDirectory(index, source);
  const records: SkillRecord[] = [];
  for (const item of skills) {
    if (item.enabled === false) continue;
    const page = createHash("sha256").update(item.id).digest("hex");
    const dir = join(index, page);
    if (!saved) await privateDirectory(dir, source);
    const path = join(dir, item.entrypoint);
    const namespace = source.namespace ?? source.id;
    const selector = item.locator.type === "notion_page" || item.locator.type === "shared_skill" ? item.locator.page_id : item.locator.type === "notion_subscription" ? item.locator.subscription_id : item.id;
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
  return { catalog: result, directory: Object.assign(attachList(records, source, observedFreshness, coverage.exhaustive), { failures, ...(selectedView ? { view: selected ?? null } : {}), ...(object(result.profile) ? { profileId: String(result.profile.profile_id) } : {}) }) };
}

export async function discoverNotionSource(source: NotionSource, cwd: string, options: Options = {}): Promise<NotionDirectory> {
  return (await discoverNotionDirectory(source, cwd, options)).directory;
}

/** Both projections use one SDK runtime; raw metadata stays inside that runtime. */
export async function discoverNotionCatalogAndDirectory(source: NotionSource, cwd: string, selection: NotionDirectorySelection, options: Options = {}): Promise<{ catalog: NotionDirectoryOutcome; directory: NotionDirectoryOutcome } | undefined> {
  if (source.command) return undefined;
  let value: unknown;
  try {
    if (!await supportsNotionSdkCatalogDirectory()) return undefined;
    value = await listNotionCatalogSdk({ ...sdkOptions(source, cwd, options.signal), ...await catalogPolicy(source, options.refresh), directory: selection });
  } catch (error) { throw sdkFailure(error, source, "list", options.signal); }
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  if (!object(value) || value.version !== 1) decodeError(source);
  const project = async (outcome: unknown, selected: Options): Promise<NotionDirectoryOutcome> => {
    if (!object(outcome) || typeof outcome.ok !== "boolean") return decodeError(source);
    if (!outcome.ok) {
      if (!object(outcome.error) || typeof outcome.error.code !== "string") return decodeError(source);
      const error = sdkFailure(outcome.error, source, "list", options.signal);
      if (!(error instanceof SourceError) || error.code === "SOURCE_CANCELLED") throw error;
      return { ok: false, code: error.code };
    }
    if (!object(outcome.value)) return decodeError(source);
    try { return { ok: true, value: (await discoverNotionDirectory(source, cwd, selected, outcome.value)).directory }; }
    catch (error) {
      if (options.signal?.aborted || error instanceof SourceError && error.code === "SOURCE_CANCELLED") throw error;
      return { ok: false, code: error instanceof SourceError ? error.code : "SOURCE_STORAGE_ERROR" };
    }
  };
  const catalog = await project(value.catalog, options);
  const directory = await project(value.directory, { ...options, ...(selection.view === undefined ? { defaultView: true } : { view: selection.view }) });
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  const scopeOf = (outcome: unknown) => object(outcome) && object(outcome.value) ? outcome.value.scope : undefined;
  if (catalog.ok && directory.ok && scopeOf(value.catalog) !== scopeOf(value.directory))
    return { catalog, directory: { ok: false, code: "SOURCE_IDENTITY_MISMATCH" } };
  return { catalog, directory };
}

/** Resolve names before entering the exact owner path. This never prepares a body. */
async function resolveNotionReferenceInSource(input: string, source: NotionSource, cwd: string, options: Pick<Options, "signal" | "refresh">): Promise<{ record: SkillRecord; ref: string }> {
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  const requested = parseNativeReference(input);
  if (!requested.snapshot) {
    const { catalog, directory } = await discoverNotionDirectory(source, cwd, options);
    // commandCatalog has already closed every page against one observation.
    // Only its transport pagination envelope is removed, never a View/query marker.
    let complete = catalog;
    if (source.command && catalog.has_more !== undefined) {
      if (catalog.has_more !== false || catalog.next_cursor !== null || catalog.total_count !== catalog.count) decodeError(source);
      const { has_more: _more, next_cursor: _cursor, total_count: _total, ...metadata } = catalog;
      complete = metadata;
    }
    const selectedReference = (resolved: unknown) => {
      if (!object(resolved) || resolved.scope !== catalog.scope || typeof resolved.ref !== "string") decodeError(source);
      const record = contentRecord(resolved.record, source), selected = directory.find(item => item.id === record.id);
      const raw = Array.isArray(catalog.records) ? catalog.records.find(item => object(item) && item.id === record.id) : undefined;
      const canonical = parseNativeReference(resolved.ref);
      if (!selected || !isDeepStrictEqual(record, raw) || canonical.selector !== parseNativeReference(record.ref).selector
        || canonical.snapshot !== undefined || canonical.path !== (requested.path || record.entrypoint)
        || canonical.fileId !== requested.fileId) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
      return { record: selected, ref: resolved.ref };
    };
    let resolved: unknown;
    try { resolved = await resolveNotionCatalogReferenceSdk(input, complete); }
    catch (error) {
      const failure = sdkFailure(error, source, "list", options.signal);
      if (!(failure instanceof SourceError) || failure.code !== "SKILL_AMBIGUOUS") throw failure;
      const details = object(error) && object(error.details) ? error.details : undefined;
      if (!details || details.selector !== requested.selector || !Array.isArray(details.candidates) || details.candidates.length < 2
        || !Array.isArray(details.exact_selectors) || details.exact_selectors.length !== details.candidates.length) decodeError(source);
      const selectors = details.exact_selectors, seen = new Set<string>();
      const candidates = details.candidates.map(value => {
        const record = contentRecord(value, source);
        if (seen.has(record.id) || selectors.filter(item => object(item) && item.id === record.id && item.ref === record.ref).length !== 1) decodeError(source);
        seen.add(record.id);
        const ref = record.ref.slice(0, record.ref.lastIndexOf("/") + 1)
          + (requested.path || record.entrypoint).split("/").map(encodeURIComponent).join("/")
          + (requested.fileId === undefined ? "" : "?file_id=" + encodeURIComponent(requested.fileId));
        return selectedReference({ record, scope: catalog.scope, ref });
      });
      throw new SourceReferenceAmbiguity(source.id, candidates);
    }
    if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
    return selectedReference(resolved);
  }
  let value: unknown;
  try {
    value = source.command
      ? await run(source, cwd, ["files", input, ...(source.database ? ["--database", source.database] : []), ...(source.activation?.offline ? ["--offline"] : [])], options.signal)
      : await listNotionFilesSdk(input, { ...sdkOptions(source, cwd, options.signal), ...(source.activation?.offline ? { offline: true } : {}) });
  } catch (error) { if (error instanceof SourceError) throw error; throw sdkFailure(error, source, "read", options.signal); }
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  if (!object(value) || !Array.isArray(value.files) || value.snapshot_id !== requested.snapshot || !HASH.test(String(value.scope))
    || typeof value.version_id !== "string" || !value.version_id) decodeError(source);
  const record = contentRecord(value.record, source), owner = parseNativeReference(record.ref), main = parseNativeReference(text(value.ref, source));
  if (![record.name, record.alias, record.id, owner.selector].includes(requested.selector)) throw new SourceError("SNAPSHOT_CONFLICT", source.id);
  if (record.enabled === false) throw new SourceError("CONTENT_DISABLED", source.id);
  if (value.entrypoint !== record.entrypoint || main.selector !== owner.selector || main.path !== record.entrypoint || main.snapshot !== requested.snapshot
    || freshness(value.freshness, source).policy !== "pinned") decodeError(source);
  if (source.database !== undefined) {
    const target = record.locator.type === "notion_subscription" ? record.locator.target_database_id
      : record.locator.type === "local" ? undefined : record.locator.database_id;
    let database = UUID.test(source.database) ? source.database : undefined;
    if (database === undefined && source.command) {
      // The historical owner comes only from its manifest. This ordinary
      // metadata lookup proves the configured database alias, not a Skill name.
      const metadataSource = source.activation?.offline ? { ...source, discovery: { ...source.discovery, offline: true } } : source;
      const authority = await discoverNotionDirectory(metadataSource, cwd, { signal: options.signal });
      if (!authority.directory.list.exhaustive || authority.directory.failures.length) throw new SourceError("CATALOG_INCOMPLETE", source.id);
      if (authority.catalog.scope !== value.scope) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
      const databases = Array.isArray(authority.catalog.databases) ? authority.catalog.databases.filter(item => object(item)
        && item.alias === source.database && (item.role === undefined || item.role === "content")) : [];
      if (databases.length !== 1 || !object(databases[0]) || typeof databases[0].database_id !== "string") decodeError(source);
      database = databases[0].database_id;
    }
    // The bundled Core already resolves aliases and checks this binding for
    // SDK files. UUIDs can also be checked without another source operation.
    if (database !== undefined && target?.replaceAll("-", "").toLowerCase() !== database.replaceAll("-", "").toLowerCase())
      throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  }
  const selectedPath = requested.path || record.entrypoint, matches = value.files.filter(file => object(file) && file.path === selectedPath);
  const file = matches[0];
  if (matches.length !== 1 || !object(file) || typeof file.ref !== "string" || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0)
    throw new SourceError("FILE_NOT_FOUND", source.id);
  const canonical = parseNativeReference(file.ref);
  if (canonical.selector !== owner.selector || canonical.snapshot !== requested.snapshot || canonical.path !== selectedPath
    || requested.fileId !== undefined && canonical.fileId !== requested.fileId) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  // Use the same metadata-stub layout as discovery; it is not a name index or body cache.
  const index = join(await cacheRoot(source, cwd), "scopes", String(value.scope), "indexes", randomUUID(), createHash("sha256").update(record.id).digest("hex"));
  await privateDirectory(index, source);
  const path = join(index, record.entrypoint), namespace = source.namespace ?? source.id;
  await writeFile(path, `---\nname: ${JSON.stringify(record.alias)}\ndescription: ${JSON.stringify(record.description)}\n---\n`, { flag: "wx", mode: 0o600 });
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  return { ref: file.ref, record: { ...record, source: "notion", sourceId: source.id, sourceScope: String(value.scope),
    path, metadataIndexPath: path, snapshotId: requested.snapshot, versionId: value.version_id, defaultDiscovery: false,
    aliases: [], normalizedAliases: [], normalizedName: record.alias, normalizedDescription: normalizeKey(record.description),
    autoloadEnabled: record.kind !== "prompt", token: `${namespace}/${record.alias}`, selectionToken: `${record.alias}@${namespace}` } };
}

/** Each configured source is an independent authority, even for the same logical ID. */
export async function resolveNotionReference(input: string, sources: readonly NotionSource[], cwd: string, options: Pick<Options, "signal" | "refresh"> = {}): Promise<{ record: SkillRecord; ref: string }> {
  const matches: Array<{ record: SkillRecord; ref: string }> = [];
  const fixed = parseNativeReference(input).snapshot !== undefined;
  let missingSnapshot: SourceError | undefined;
  for (const source of sources) {
    if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
    try { matches.push(await resolveNotionReferenceInSource(input, source, cwd, options)); }
    catch (error) {
      // Only complete, authorized absence can be ignored. A partial or failed
      // source cannot be hidden by a name match in another configured scope.
      if (!(error instanceof SourceError)) throw error;
      if (error instanceof SourceReferenceAmbiguity) matches.push(...error.candidates);
      else if (fixed && error.code === "SNAPSHOT_MISSING") missingSnapshot ??= error;
      else if (error.code !== "SKILL_NOT_FOUND") throw error;
    }
  }
  if (options.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", "notion");
  if (!matches.length && missingSnapshot) throw missingSnapshot;
  if (matches.length > 1) throw new SourceReferenceAmbiguity("notion", matches);
  if (!matches.length) throw new SourceError("SKILL_NOT_FOUND", "notion");
  return matches[0]!;
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
  const result = await run(source, cwd, ["ctl", "views", ...(source.database ? ["--database", source.database] : []), ...policyArgs(source.discovery)], signal);
  if (!Array.isArray(result.views) || result.count !== result.views.length) decodeError(source);
  return result.views.map(view => parseView(view, source));
}

function attachList(records: SkillRecord[], source: NotionSource, value: Json, exhaustive: boolean): SkillRecord[] & { list: NotionListObservation } {
  const policy = String(value.policy) as NotionListObservation["policy"];
  const list: NotionListObservation = policy === "pinned"
    ? { sourceId: source.id, policy, exhaustive }
    : { sourceId: source.id, policy, exhaustive, validatedAt: String(value.validated_at), ageMs: Number(value.age_ms), maxAgeMs: Number(value.max_age_ms), stale: value.stale === true };
  Object.defineProperty(records, "list", { value: list });
  return records as SkillRecord[] & { list: NotionListObservation };
}

function portablePath(value: unknown, source: NotionSource): string {
  const path = text(value, source);
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(path)) decodeError(source);
  return path;
}
function nativeBindings(value: unknown, source: NotionSource): readonly NativeFileBinding[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) decodeError(source);
  const ids = new Set<string>(), pages = new Set<string>(), paths = new Set<string>();
  return value.map(item => {
    if (!object(item) || typeof item.file_id !== "string" || !item.file_id
      || item.file_id.trim() !== item.file_id || item.file_id.length > 256 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(item.file_id)
      || typeof item.page_id !== "string" || !UUID.test(item.page_id)) decodeError(source);
    const path = portablePath(item.path, source);
    if (ids.has(item.file_id) || pages.has(item.page_id) || paths.has(path)) decodeError(source);
    ids.add(item.file_id); pages.add(item.page_id); paths.add(path);
    return { file_id: item.file_id, page_id: item.page_id, path };
  });
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
  const selected = contentRecord({ id: record.id, kind: record.kind, locator: record.locator, name: record.name, alias: record.alias, description: record.description, default_context: record.default_context, ...(record.enabled === undefined ? {} : { enabled: record.enabled }), entrypoint: record.entrypoint, ref: record.ref }, source);
  if (selected.enabled === false) throw new SourceError("CONTENT_DISABLED", source.id);
  const sameIdentity = (item: ContentRecord) => item.id === selected.id && item.kind === selected.kind && isDeepStrictEqual(item.locator, selected.locator) && item.entrypoint === selected.entrypoint && item.ref === selected.ref;
  if (options.snapshotId !== undefined && !SNAPSHOT.test(options.snapshotId)) throw new SourceError("SOURCE_REFERENCE_INVALID", source.id);
  const read = await run(source, cwd, ["read", options.snapshotId ? `${record.ref}?snapshot=${options.snapshotId}` : record.ref, ...(source.database ? ["--database", source.database] : []), ...(options.snapshotId ? [] : policyArgs(source.activation))], options.signal, record.locator.type === "notion_page" || record.locator.type === "shared_skill" ? record.locator.page_id : undefined);
  if ("skill" in read || "skill_name" in read) decodeError(source);
  const current = contentRecord(read.record, source);
  if (current.enabled === false) throw new SourceError("CONTENT_DISABLED", source.id);
  const snapshot = text(read.snapshot_id, source);
  if (options.snapshotId && snapshot !== options.snapshotId) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  const version = text(read.version_id, source);
  // Names and aliases may change after selection; the exact page, scope and entry remain authoritative.
  if (!sameIdentity(current) || !SNAPSHOT.test(snapshot) || read.scope !== record.sourceScope) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  const fileBindings = nativeBindings(read.file_bindings, source);
  let pinnedReference: ReturnType<typeof parseNativeReference>;
  try { pinnedReference = parseNativeReference(text(read.ref, source)); }
  catch { return decodeError(source); }
  const mainBinding = fileBindings?.find(binding => binding.path === current.entrypoint);
  if (pinnedReference.selector !== parseNativeReference(current.ref).selector
    || pinnedReference.path !== current.entrypoint || pinnedReference.snapshot !== snapshot
    || pinnedReference.fileId !== mainBinding?.file_id || fileBindings && !mainBinding
    || mainBinding && (current.locator.type !== "shared_skill" || mainBinding.page_id !== current.locator.page_id)) decodeError(source);
  if (typeof read.content !== "string" || read.has_more !== false || !object(read.range) || typeof read.range.total_lines !== "number" || !Number.isSafeInteger(read.range.total_lines) || read.range.total_lines < 1 || read.range.start !== 1 || read.range.end !== read.range.total_lines || read.path !== current.entrypoint || read.entrypoint !== current.entrypoint) decodeError(source);
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
      return { ...record, ...current, upstream: current.upstream, path, body: read.content, normalizedName: current.alias, normalizedDescription: normalizeKey(current.description), snapshotId: snapshot, versionId: version, freshness: observedFreshness, ...(fileBindings === undefined ? {} : { fileBindings }) };
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
  return { ...record, ...current, upstream: current.upstream, path, body, normalizedName: current.alias, normalizedDescription: normalizeKey(current.description), snapshotId: snapshot, versionId: version, freshness: observedFreshness, ...(fileBindings === undefined ? {} : { fileBindings }) };
}

type GraphRequest = {
  purpose: PreparationPurpose; sessionBindings?: readonly PreparationBinding[]; signal?: AbortSignal; rootPins?: ReadonlyMap<string, string>; refresh?: boolean;
  prefetch?: PrefetchBudget; transport?: "sdk";
};
type PreparedNode = ReturnType<typeof decodePreparedGraph>["nodes"][number];
async function loadPreparedEntry(metadata: SkillRecord, node: PreparedNode, source: NotionSource, cwd: string, signal?: AbortSignal): Promise<SkillRecord> {
  const read = await run(source, cwd, ["read", node.binding.ref, ...(source.database ? ["--database", source.database] : [])], signal,
    node.record.locator.type === "shared_skill" || node.record.locator.type === "notion_page" ? node.record.locator.page_id : undefined, node.id);
  const current = contentRecord(read.record, source);
  const fileBindings = nativeBindings(read.file_bindings, source);
  const mainBinding = fileBindings?.find(binding => binding.path === current.entrypoint);
  const observedFreshness = freshness(read.freshness, source);
  if (!isDeepStrictEqual(current, node.record) || current.enabled === false || read.scope !== node.binding.scope ||
    read.snapshot_id !== node.binding.snapshot_id || read.version_id !== node.binding.version_id ||
    read.ref !== node.binding.ref || read.path !== current.entrypoint || read.entrypoint !== current.entrypoint ||
    read.content !== node.content || read.has_more !== false || !object(read.range) ||
    !Number.isSafeInteger(read.range.total_lines) || Number(read.range.total_lines) < 1 ||
    read.range.start !== 1 || read.range.end !== read.range.total_lines ||
    mainBinding && (current.locator.type !== "shared_skill" || mainBinding.page_id !== current.locator.page_id) ||
    fileBindings && !mainBinding || parseNativeReference(node.binding.ref).fileId !== mainBinding?.file_id ||
    read.materialization !== undefined && (!object(read.materialization) || read.materialization.manifest_complete !== true) ||
    observedFreshness.policy !== "pinned") {
    throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
  }
  const record: SkillRecord = { ...metadata, ...current, path: node.path, body: node.content,
    snapshotId: node.binding.snapshot_id, versionId: node.binding.version_id, freshness: observedFreshness,
    preparationBinding: node.binding, preparationDirectory: { files: node.files, required: node.required, candidates: node.candidates, references: node.references },
    ...(fileBindings === undefined ? {} : { fileBindings }),
  };
  return publishNotionEntry(record, node.files, await cacheRoot(source, cwd), path => privateDirectory(path, source), signal);
}

/** consume already proves complete source bytes and File bindings; no second CLI read is needed. */
async function loadConsumedEntry(metadata: SkillRecord, node: PreparedNode, entry: Json, source: NotionSource, cwd: string, signal?: AbortSignal): Promise<SkillRecord> {
  if (!object(entry.manifest) || !object(entry.source_body)) throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
  const manifest = entry.manifest, body = entry.source_body;
  const current = contentRecord(manifest.record, source);
  const fileBindings = nativeBindings(manifest.file_bindings, source);
  const mainBinding = fileBindings?.find(binding => binding.path === current.entrypoint);
  if (entry.id !== node.id || manifest.complete !== true || !isDeepStrictEqual(current, node.record) || current.enabled === false
    || manifest.scope !== node.binding.scope || manifest.snapshot_id !== node.binding.snapshot_id || manifest.version_id !== node.binding.version_id
    || manifest.entrypoint !== current.entrypoint || body.ref !== node.binding.ref || body.path !== current.entrypoint || body.sha256 !== node.body_sha256
    || body.bytes !== node.bytes || body.has_more !== false || !object(body.range) || body.range.start !== 1
    || body.range.end !== body.range.total_lines || !Number.isSafeInteger(body.range.total_lines) || Number(body.range.total_lines) < 1
    || mainBinding && (current.locator.type !== "shared_skill" || mainBinding.page_id !== current.locator.page_id)
    || fileBindings && !mainBinding || parseNativeReference(node.binding.ref).fileId !== mainBinding?.file_id) throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
  const record: SkillRecord = { ...metadata, ...current, path: node.path, body: node.content,
    snapshotId: node.binding.snapshot_id, versionId: node.binding.version_id, freshness: { policy: "pinned" },
    preparationBinding: node.binding, preparationDirectory: { files: node.files, required: node.required, candidates: node.candidates, references: node.references },
    ...(fileBindings === undefined ? {} : { fileBindings }),
  };
  return publishNotionEntry(record, node.files, await cacheRoot(source, cwd), path => privateDirectory(path, source), signal);
}

function fixedOwnerBinding(record: ContentRecord, scope: string, snapshot: string, version: string, mainHash: string, bindings: readonly NativeFileBinding[] | undefined): PreparationBinding {
  const owner = parseNativeReference(record.ref), query = new URLSearchParams({ snapshot });
  const main = bindings?.find(file => file.path === record.entrypoint);
  if (main) query.set("file_id", main.file_id);
  return { record, scope, snapshot_id: snapshot, version_id: version, body_sha256: mainHash,
    ref: "skill://" + encodeURIComponent(owner.selector) + "/" + record.entrypoint.split("/").map(encodeURIComponent).join("/") + "?" + query.toString() };
}

/** A single scalar SDK operation materializes the exact resource for native read.
 * Unsupported transports and main File aliases retain their existing route. */
export async function readFixedNotionResource(record: SkillRecord, fixedRef: string, source: NotionSource, cwd: string, signal?: AbortSignal, transport?: "sdk"): Promise<FixedResourceRead | undefined> {
  if (transport !== "sdk" || source.command) return undefined;
  if (signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  if (record.source !== "notion" || record.sourceId !== source.id || !record.id || !record.ref || !record.sourceScope || !HASH.test(record.sourceScope))
    throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  const requested = parseNativeReference(fixedRef);
  if (!requested.path || !requested.snapshot || requested.selector !== parseNativeReference(record.ref).selector)
    throw new SourceError("SOURCE_REFERENCE_INVALID", source.id);
  try { if (!await supportsNotionSdkReadOutputProof()) return undefined; }
  catch (error) { throw sdkFailure(error, source, "read", signal, record); }
  if (signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  const cache = await cacheRoot(source, cwd), stage = join(cache, ".resource-stage-" + randomUUID());
  await privateDirectory(stage, source);
  const output = join(stage, "file");
  let value: unknown;
  try { value = await readNotionSdk(fixedRef, { ...sdkOptions(source, cwd, signal), output, ...(source.activation?.offline ? { offline: true } : {}) }); }
  catch (error) { throw sdkFailure(error, source, "read", signal, record); }
  if (signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  if (!object(value) || typeof value.sha256 !== "string" || !HASH.test(value.sha256)
    || typeof value.entrypoint_sha256 !== "string" || !HASH.test(value.entrypoint_sha256)
    || typeof value.version_id !== "string" || !value.version_id || typeof value.path !== "string" || typeof value.ref !== "string"
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0) decodeError(source);
  const current = contentRecord(value.record, source), canonicalOwner = parseNativeReference(current.ref);
  const bindings = nativeBindings(value.file_bindings, source), ref = parseNativeReference(value.ref);
  const bound = bindings?.find(file => file.path === value.path), snapshotId = requested.snapshot;
  if (value.scope !== record.sourceScope || current.id !== record.id || current.kind !== record.kind || !isDeepStrictEqual(current.locator, record.locator)
    || value.snapshot_id !== snapshotId || value.entrypoint !== current.entrypoint || canonicalOwner.selector !== requested.selector
    || ref.selector !== canonicalOwner.selector || ref.snapshot !== snapshotId || ref.path !== value.path || ref.fileId !== bound?.file_id
    || requested.fileId !== undefined && requested.fileId !== ref.fileId || requested.fileId === undefined && requested.path !== ref.path)
    throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  if (value.output !== output || typeof value.reused !== "boolean" || freshness(value.freshness, source).policy !== "pinned"
    || value.materialization !== undefined && (!object(value.materialization) || value.materialization.manifest_complete !== true))
    throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
  if (value.path === current.entrypoint) {
    if (value.sha256 !== value.entrypoint_sha256) decodeError(source);
    return undefined;
  }
  const file: ResourceReadFileIdentity = { requested_ref: fixedRef, ref: value.ref, path: value.path, bytes: Number(value.bytes), sha256: value.sha256,
    ...(ref.fileId === undefined ? {} : { file_id: ref.fileId }) };
  const resourceRecord: SkillRecord = { ...record, snapshotId, versionId: value.version_id, entrypoint: current.entrypoint, fileBindings: bindings };
  const materialized = await publishNotionResourceFile(resourceRecord, file, output, cache, target => privateDirectory(target, source), signal);
  return { selection: { scope: record.sourceScope, owner: current.id, snapshot_id: snapshotId, version_id: value.version_id },
    ownerBinding: fixedOwnerBinding(current, record.sourceScope, snapshotId, value.version_id, value.entrypoint_sha256, bindings),
    entrypoint: current.entrypoint, file: materialized };
}

export async function loadNotionResource(record: SkillRecord, path: string, source: NotionSource, cwd: string, signal?: AbortSignal, transport?: "sdk"): Promise<string> {
  if (record.sourceId !== source.id || !record.entryManifest || !record.snapshotId || !record.sourceScope || !record.preparationBinding)
    throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  return materializeNotionEntryFile(record, path, target => privateDirectory(target, source), async (file, output) => {
    let response: Json;
    if (transport === "sdk" && !source.command) {
      let value: unknown;
      try { value = await readNotionSdk(file.ref, { ...sdkOptions(source, cwd, signal), output }); }
      catch (error) { throw sdkFailure(error, source, "read", signal); }
      if (!object(value)) throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
      response = value;
    } else response = await run(source, cwd, ["read", file.ref, "--output", output, ...(source.database ? ["--database", source.database] : [])], signal);
    const current = contentRecord(response.record, source);
    if (!isDeepStrictEqual(current, record.preparationBinding!.record) || response.scope !== record.sourceScope ||
      response.snapshot_id !== record.snapshotId || response.version_id !== record.versionId ||
      response.entrypoint !== record.entrypoint || response.path !== file.path || response.ref !== file.ref ||
      response.output !== output || response.bytes !== file.bytes || typeof response.reused !== "boolean" ||
      !isDeepStrictEqual(nativeBindings(response.file_bindings, source), record.fileBindings) ||
      response.materialization !== undefined && (!object(response.materialization) || response.materialization.manifest_complete !== true) ||
      freshness(response.freshness, source).policy !== "pinned") throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
  }, signal);
}

/** One SDK operation verifies the owner manifest and reads only the selected
 * resources. This path never prepares, opens or publishes the main Skill body. */
export async function readNotionResources(record: SkillRecord, refs: readonly string[], source: NotionSource, cwd: string, signal?: AbortSignal): Promise<ResourceReadBatch> {
  if (record.source !== "notion" || record.sourceId !== source.id || !record.id || !record.ref || !record.sourceScope) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  // A custom source command owns its transport. Do not silently switch its data
  // or credentials to the bundled SDK when it has no resource-batch contract.
  if (source.command) throw new SourceError("SOURCE_RESOURCE_BATCH_UNAVAILABLE", source.id);
  if (signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  const request = { version: 1, refs: [...refs], budget: DEFAULT_RESOURCE_READ_BUDGET };
  let value: unknown;
  try { value = await readNotionResourcesSdk(request, { ...sdkOptions(source, cwd, signal), ...(source.activation?.offline ? { offline: true } : {}) }); }
  catch (error) { throw sdkFailure(error, source, "read", signal, record); }
  if (signal?.aborted || object(value) && value.status === "cancelled") throw new SourceError("SOURCE_CANCELLED", source.id);
  if (object(value) && value.status === "failed") throw sdkFailure(value.error, source, "read", signal, record);
  if (!object(value) || value.version !== 1 || value.status !== "ready" || !object(value.manifest) || !object(value.selection)
    || !Array.isArray(value.files) || value.files.length !== refs.length || !object(value.budget)
    || !isDeepStrictEqual(value.budget, DEFAULT_RESOURCE_READ_BUDGET) || typeof value.manifest_sha256 !== "string" || !HASH.test(value.manifest_sha256)) decodeError(source);
  const manifest = value.manifest, selection = value.selection, current = contentRecord(manifest.record, source);
  if (manifest.complete !== true || manifest.scope !== record.sourceScope || current.id !== record.id || current.kind !== record.kind
    || !isDeepStrictEqual(current.locator, record.locator) || manifest.entrypoint !== current.entrypoint
    || typeof manifest.snapshot_id !== "string" || !SNAPSHOT.test(manifest.snapshot_id) || typeof manifest.version_id !== "string" || !manifest.version_id
    || selection.scope !== manifest.scope || selection.owner !== current.id || selection.snapshot_id !== manifest.snapshot_id || selection.version_id !== manifest.version_id
    || !Array.isArray(manifest.files)) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  const manifestFiles = manifest.files;
  const bindings = nativeBindings(manifest.file_bindings, source), main = manifestFiles.find(file => object(file) && file.path === current.entrypoint);
  if (!object(main) || typeof main.sha256 !== "string" || !HASH.test(main.sha256)) decodeError(source);
  const canonicalOwner = parseNativeReference(current.ref), snapshotId = manifest.snapshot_id;
  const ownerBinding = fixedOwnerBinding(current, record.sourceScope, snapshotId, manifest.version_id, main.sha256, bindings);
  const seen = new Set<string>();
  const selected: ResourceReadWireFile[] = value.files.map((raw, index) => {
    if (!object(raw) || raw.requested_ref !== refs[index] || typeof raw.ref !== "string" || typeof raw.path !== "string"
      || typeof raw.content !== "string" || !["utf8", "base64"].includes(String(raw.encoding))
      || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0 || typeof raw.sha256 !== "string" || !HASH.test(raw.sha256)) return decodeError(source);
    const ref = parseNativeReference(raw.ref), requested = parseNativeReference(refs[index]!);
    const bound = bindings?.find(file => file.path === raw.path);
    const declared = manifestFiles.find(file => object(file) && file.path === raw.path);
    if (ref.selector !== canonicalOwner.selector || requested.selector !== canonicalOwner.selector || ref.snapshot !== snapshotId || requested.snapshot !== snapshotId
      || ref.path !== raw.path || ref.fileId !== raw.file_id || ref.fileId !== bound?.file_id || raw.path === current.entrypoint
      || requested.fileId !== undefined && requested.fileId !== ref.fileId || requested.fileId === undefined && requested.path !== ref.path
      || !object(declared) || declared.bytes !== raw.bytes || declared.sha256 !== raw.sha256) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
    const key = ref.fileId === undefined ? "path:" + ref.path : "file:" + ref.fileId;
    if (seen.has(key)) throw new SourceError("RESOURCE_SELECTION_CONFLICT", source.id);
    seen.add(key);
    return { requested_ref: refs[index]!, ref: raw.ref, path: raw.path, bytes: Number(raw.bytes), sha256: raw.sha256,
      ...(ref.fileId === undefined ? {} : { file_id: ref.fileId }), encoding: raw.encoding as "utf8" | "base64", content: raw.content };
  });
  const resourceRecord: SkillRecord = { ...record, snapshotId, versionId: manifest.version_id, entrypoint: current.entrypoint, fileBindings: bindings };
  const files = await materializeNotionResourceBatch(resourceRecord, selected, await cacheRoot(source, cwd), target => privateDirectory(target, source), signal);
  if (signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  return { selection: { scope: record.sourceScope, owner: current.id, snapshot_id: snapshotId, version_id: manifest.version_id },
    ownerBinding, manifest, manifest_sha256: value.manifest_sha256, files, budget: { ...DEFAULT_RESOURCE_READ_BUDGET }, machine: value };
}
async function requestPreparedGraph(records: readonly SkillRecord[], source: NotionSource, cwd: string, input: GraphRequest) {
  if (!records.length || records.some(record => record.sourceId !== source.id || !record.id || !record.ref || !record.sourceScope)) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
  const targets = records.map(record => input.rootPins?.has(record.id!) ? record.ref! + "?snapshot=" + input.rootPins.get(record.id!) : record.ref!);
  if (input.transport === "sdk" && !source.command) {
    if (input.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
    const request = { version: 1, targets, purpose: input.purpose, freshness: await sdkFreshness(source, input.refresh),
      ...(input.sessionBindings?.length ? { sessionBindings: input.sessionBindings } : {}),
      ...(source.preparation ? { budget: source.preparation } : {}) };
    let response: unknown;
    try { response = await consumeNotionSdk(request, { ...sdkOptions(source, cwd, input.signal), ...(input.prefetch ? { execution: { priority: "prefetch",
      timeBudgetMs: input.prefetch.maxTimeMs, queueBudgetMs: Math.min(1000, input.prefetch.maxTimeMs), rateShare: input.prefetch.rateShare } } : {}) }); }
    catch (error) { throw sdkFailure(error, source, "prepare", input.signal, records.length === 1 ? records[0] : undefined); }
    if (input.signal?.aborted || object(response) && response.status === "cancelled") throw new SourceError("SOURCE_CANCELLED", source.id);
    if (object(response) && response.status === "failed") throw sdkFailure(response.error, source, "prepare", input.signal, records.length === 1 ? records[0] : undefined);
    if (!object(response) || response.version !== 1 || response.status !== "ready" || !object(response.preparation) || !Array.isArray(response.entries)) throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
    let ready: ReturnType<typeof decodePreparedGraph>;
    try { ready = decodePreparedGraph({ ...response.preparation, ok: true }, { purpose: input.purpose, roots: records }, value => contentRecord(value, source)); }
    catch (error) { if (error instanceof SourceError) throw error; throw new SourceError("SOURCE_PREPARATION_INVALID", source.id); }
    const entries = new Map<string, Json>();
    for (const entry of response.entries) {
      if (!object(entry) || typeof entry.id !== "string" || entries.has(entry.id)) throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
      entries.set(entry.id, entry);
    }
    if (entries.size !== ready.nodes.length || ready.nodes.some(node => !entries.has(node.id))) throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
    return { ready, entries };
  }
  const args = ["prepare", ...targets, "--purpose", input.purpose,
    ...(source.database ? ["--database", source.database] : []), ...policyArgs(source.activation, input.refresh)];
  if (input.prefetch) args.push("--priority", "prefetch", "--time-budget-ms", String(input.prefetch.maxTimeMs),
    "--queue-budget-ms", String(Math.min(1000, input.prefetch.maxTimeMs)), "--rate-share", String(input.prefetch.rateShare));
  if (input.sessionBindings?.length) {
    const directory = join(await cacheRoot(source, cwd), "preparations");
    await privateDirectory(directory, source);
    const path = join(directory, randomUUID() + ".json");
    await writeFile(path, JSON.stringify(input.sessionBindings), { flag: "wx", mode: 0o600 });
    args.push("--session-bindings", path);
  }
  for (const [key, flag] of [
    ["maxNodes", "--max-nodes"], ["maxDepth", "--max-depth"],
    ["maxInstructionBytes", "--max-instruction-bytes"], ["maxContextBytes", "--max-context-bytes"],
  ] as const) {
    const value = source.preparation?.[key];
    if (value !== undefined) args.push(flag, String(value));
  }
  const single = records.length === 1 ? records[0] : undefined;
  const response = await run(source, cwd, args, input.signal,
    single?.locator?.type === "shared_skill" || single?.locator?.type === "notion_page" ? single.locator.page_id : undefined, single?.id);
  let ready: ReturnType<typeof decodePreparedGraph>;
  try { ready = decodePreparedGraph(response, { purpose: input.purpose, roots: records }, value => contentRecord(value, source)); }
  catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
  }
  if (input.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
  return { ready, entries: undefined };
}

/** Warm the CLI's verified cache only. No host directory, session lock or delivery is published. */
export async function prefetchNotionSkills(plan: PrefetchPlan, cwd: string, signal: AbortSignal): Promise<PrefetchOutcome> {
  const { ready } = await requestPreparedGraph(plan.records, {
    ...plan.source,
    preparation: { maxNodes: plan.budget.maxNodes, maxDepth: plan.budget.maxDepth,
      maxInstructionBytes: plan.budget.maxBytes, maxContextBytes: plan.budget.maxBytes },
  }, cwd, { purpose: "inspect", signal, prefetch: plan.budget });
  return {
    preparedNodes: ready.usage.prepared_nodes, instructionBytes: ready.usage.instruction_bytes, contextBytes: ready.usage.context_bytes,
    records: ready.nodes.map(node => ({ id: node.id, scope: ready.scope, snapshotId: node.binding.snapshot_id, bodySha256: node.body_sha256, bytes: node.bytes })),
  };
}

/** The selected transport prepares the graph; the host publishes only verified immutable entries. */
export async function prepareNotionSkills(records: readonly SkillRecord[], source: NotionSource, cwd: string, input: Omit<GraphRequest, "prefetch">): Promise<PreparedHostGraph> {
  const { ready, entries } = await requestPreparedGraph(records, source, cwd, input);
  const prepared: SkillRecord[] = [];
  for (const node of ready.nodes) {
    if (input.signal?.aborted) throw new SourceError("SOURCE_CANCELLED", source.id);
    const selected = records.find(record => record.id === node.id);
    const metadata: SkillRecord = {
      ...node.record, source: "notion", sourceId: source.id, sourceScope: ready.scope, path: selected?.path ?? node.path,
      aliases: [], normalizedAliases: [], normalizedName: node.record.alias, normalizedDescription: normalizeKey(node.record.description),
      autoloadEnabled: node.record.kind !== "prompt", token: selected?.token ?? (source.namespace ?? source.id) + "/" + node.record.alias,
      defaultDiscovery: selected?.defaultDiscovery ?? false,
    };
    let loaded: SkillRecord;
    try { loaded = entries ? await loadConsumedEntry(metadata, node, entries.get(node.id)!, source, cwd, input.signal) : await loadPreparedEntry(metadata, node, source, cwd, input.signal); }
    catch (error) {
      if (!(error instanceof ReferenceMiss)) throw error;
      if (records.some(record => record.id === node.id) && !ready.required.some(edge => edge.to === node.id)) throw new ReferenceMiss(source.id, node.id);
      throw new SourceError("PREPARE_REQUIRED_UNAVAILABLE", source.id);
    }
    const mainFileId = loaded.fileBindings?.find(binding => binding.path === loaded.entrypoint)?.file_id;
    if (loaded.body !== node.content || loaded.versionId !== node.binding.version_id
      || parseNativeReference(node.binding.ref).fileId !== mainFileId
      || createHash("sha256").update(loaded.body).digest("hex") !== node.body_sha256 || Buffer.byteLength(loaded.body) !== node.bytes) {
      throw new SourceError("SOURCE_PREPARATION_INVALID", source.id);
    }
    prepared.push({ ...loaded, preparationBinding: node.binding,
      preparationDirectory: { files: node.files, required: node.required, candidates: node.candidates, references: node.references } });
  }
  return {
    purpose: ready.purpose, scope: ready.scope, sourceId: source.id, roots: ready.roots.map(root => root.id),
    records: prepared, bindings: ready.session_bindings, lock: ready.graph_lock, budget: ready.budget, usage: ready.usage,
  };
}
