import { parseNativeReference, notionPageId } from "./native-reference";
import { sharedSkillId } from "./shared-skill-identity";
import type { ContentLocator, ContentRecord } from "./types";
import type { AuthorizationPresentation } from "./pi-authorization";

export const CONTENT_SEARCH_MAX_RESULTS = 50;
export const CONTENT_SEARCH_TIMEOUT_MS = 360_000;
export type ContentSearchRequest = { readonly query: string; readonly limit: number };
export type ContentSearchOptions = {
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly onAuthorize?: (request: AuthorizationPresentation) => Promise<void>;
};
type NotionLocator = Extract<ContentLocator, { type: "shared_skill" }>;
export type ContentSearchRecord = ContentRecord & {
  locator: NotionLocator;
  match: {
    kind: "notion_remote_match";
    pageId: string;
    url?: string;
    title?: string;
    snippet?: string;
    representation: "native" | "projection" | "supporting_file";
  };
};
export type ContentSearchResult = {
  kind: "results";
  records: ContentSearchRecord[];
  connection: { id: string; grantEpoch: string };
  resultId: string;
  coverage: "remote_non_exhaustive";
  partial: boolean;
  notices: Array<{ code: string; message: string }>;
  exhaustive: false;
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => Object.assign(new Error("CONTENT_SEARCH_RESPONSE_INVALID"), { code: "CONTENT_SEARCH_RESPONSE_INVALID" });
function text(value: unknown, max = 8192): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw invalid();
  return value;
}
function nonempty(value: unknown, max = 8192): string {
  const result = text(value, max);
  if (!result.trim()) throw invalid();
  return result;
}
function locator(value: unknown): NotionLocator {
  if (!object(value) || value.type !== "shared_skill") throw invalid();
  const page_id = nonempty(value.page_id, 64), database_id = nonempty(value.database_id, 64), data_source_id = nonempty(value.data_source_id, 64);
  if (![page_id, database_id, data_source_id].every(id => notionPageId(id))) throw invalid();
  const library_id = nonempty(value.library_id, 200), skill_id = nonempty(value.skill_id, 200);
  if (notionPageId(library_id) !== library_id || !sharedSkillId(library_id, skill_id)) throw invalid();
  return { type: "shared_skill", page_id, database_id, data_source_id, library_id, skill_id };
}
function record(value: unknown): ContentSearchRecord {
  if (!object(value) || !object(value.match) || value.match.kind !== "notion_remote_match") throw invalid();
  const owner = locator(value.locator), ref = nonempty(value.ref);
  const parsed = parseNativeReference(ref);
  const id = sharedSkillId(owner.library_id, owner.skill_id), kind = value.kind;
  const entrypoint = nonempty(value.entrypoint);
  if (id === undefined || value.id !== id || parsed.selector !== id || parsed.snapshot || parsed.path !== entrypoint
    || kind !== "skill" && kind !== "router" && kind !== "prompt"
    || typeof value.default_context !== "boolean" || value.enabled !== true) throw invalid();
  const representation = value.match.representation;
  if (representation !== "native" && representation !== "projection" && representation !== "supporting_file") throw invalid();
  const pageId = nonempty(value.match.pageId, 64);
  if (!notionPageId(pageId)) throw invalid();
  const urlText = value.match.url === undefined ? undefined : nonempty(value.match.url, 4096);
  if (urlText !== undefined) {
    let url: URL;
    try { url = new URL(urlText); } catch { throw invalid(); }
    if (url.protocol !== "https:" || url.username || url.password
      || !["notion.so", "notion.site", "www.notion.so", "www.notion.site"].includes(url.hostname)
        && !url.hostname.endsWith(".notion.so") && !url.hostname.endsWith(".notion.site")) throw invalid();
  }
  return {
    id, kind, ref, entrypoint, enabled: true, default_context: value.default_context,
    name: nonempty(value.name, 1024), alias: nonempty(value.alias, 1024), description: text(value.description), locator: owner,
    match: { kind: "notion_remote_match", pageId, representation,
      ...(urlText === undefined ? {} : { url: urlText }),
      ...(value.match.title === undefined ? {} : { title: text(value.match.title, 2048) }),
      ...(value.match.snippet === undefined ? {} : { snippet: text(value.match.snippet) }) },
  };
}

/** The dynamically loaded SDK is a versioned boundary. Never forward extra fields. */
export function decodeContentSearchResult(value: unknown): ContentSearchResult {
  if (!object(value) || value.kind !== "results" || !Array.isArray(value.records) || value.records.length > CONTENT_SEARCH_MAX_RESULTS
    || !object(value.connection)
    || value.coverage !== "remote_non_exhaustive" || value.exhaustive !== false || typeof value.partial !== "boolean"
    || !Array.isArray(value.notices) || value.notices.length > 32) throw invalid();
  const records = value.records.map(record);
  const notices = value.notices.map((notice: unknown) => {
    if (!object(notice) || typeof notice.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(notice.code)) throw invalid();
    return { code: notice.code, message: text(notice.message, 2048) };
  });
  const result: ContentSearchResult = {
    kind: "results", records, connection: { id: nonempty(value.connection.id, 512), grantEpoch: nonempty(value.connection.grantEpoch, 512) },
    resultId: nonempty(value.resultId, 512), coverage: "remote_non_exhaustive", exhaustive: false, partial: value.partial, notices,
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 262_144) throw invalid();
  return result;
}

const authCodes = new Set(["MCP_AUTH_REQUIRED", "MCP_AUTH_REAUTH_REQUIRED", "MCP_REAUTH_REQUIRED", "MCP_AUTH_INTERACTION_REQUIRED",
  "MCP_AUTH_BROWSER_UNAVAILABLE", "MCP_AUTH_CALLBACK_UNAVAILABLE"]);
const cancelledCodes = new Set(["MCP_AUTH_CANCELLED", "MCP_CANCELLED", "CANCELLED", "SOURCE_CANCELLED"]);
const unsupportedCodes = new Set(["MCP_UNSUPPORTED", "MCP_PROTOCOL_UNSUPPORTED", "MCP_TOOL_UNSUPPORTED", "MCP_CAPABILITY_UNAVAILABLE",
  "MCP_AUTH_UNSUPPORTED", "SOURCE_SDK_UNAVAILABLE", "SOURCE_SDK_INCOMPATIBLE"]);
const safeCodes = new Set([...authCodes, ...cancelledCodes, ...unsupportedCodes,
  "AUTH_REQUIRED", "ACCESS_DENIED", "SOURCE_UNAVAILABLE", "SOURCE_RESPONSE_INVALID", "CONTENT_DISABLED", "NOT_FOUND",
  "MCP_AUTH_TIMEOUT", "MCP_AUTH_URL_INVALID", "MCP_AUTH_FAILED", "MCP_TOKEN_INVALID", "MCP_AUTH_INVALID_GRANT",
  "MCP_FORBIDDEN", "MCP_RATE_LIMITED", "MCP_TIMEOUT", "MCP_NETWORK_ERROR", "MCP_RESPONSE_INVALID", "MCP_WORKSPACE_MISMATCH",
  "MCP_AUTH_INVALID_TOKEN", "MCP_AUTH_INVALID_ARGUMENT", "MCP_AUTH_INVALID_RESPONSE", "MCP_AUTH_HTTP_ERROR", "MCP_AUTH_UNAVAILABLE",
  "MCP_AUTH_CALLBACK_INVALID", "MCP_AUTH_DENIED", "MCP_AUTH_IDENTITY_REQUIRED", "MCP_AUTH_IDENTITY_MISMATCH", "MCP_AUTH_TOKEN_ACTIVE",
  "MCP_AUTH_STALE", "MCP_STATE_CORRUPT", "MCP_SOURCE_UNAVAILABLE", "MCP_SEARCH_STALE", "MCP_ADMISSION_FAILED", "MCP_BUDGET_EXCEEDED",
  "MCP_INVALID_RESPONSE", "MCP_UNAVAILABLE", "MCP_ACCESS_DENIED",
  "CONTENT_SEARCH_FAILED", "CONTENT_SEARCH_TIMEOUT", "CONTENT_SEARCH_RESPONSE_INVALID", "CONTENT_SEARCH_OFFLINE"]);

/** Messages are local constants. Transport diagnostics and OAuth bytes stay private. */
export function contentSearchFailure(error: unknown) {
  const received = object(error) && typeof error.code === "string" ? error.code : undefined;
  const code = received !== undefined && safeCodes.has(received) ? received : "CONTENT_SEARCH_FAILED";
  const state = authCodes.has(code) ? "auth_required" : cancelledCodes.has(code) ? "cancelled" : unsupportedCodes.has(code) ? "unsupported" : "failed";
  const message = state === "auth_required"
    ? "Notion content search needs authorization. Run the host-local ntn-skills auth mcp login command, then repeat this content search."
    : state === "cancelled" ? "Notion content search was cancelled."
    : state === "unsupported" ? "This installed CLI/SDK does not provide the required Notion content search capability."
    : code === "AUTH_REQUIRED" || code === "ACCESS_DENIED"
      ? "The selected Skills source could not establish REST access. MCP authorization does not grant REST access."
    : "Notion content search did not complete. This result does not establish that a Skill or matching content is absent.";
  return { ok: false, search_in: "content", state, error: { code, message }, exhaustive: false, next_cursor: null };
}
