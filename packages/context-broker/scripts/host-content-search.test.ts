import { nativeFileRef, nativeSkillId, withNativeSnapshot } from "../src/native-reference";
import { expect, test, setSystemTime } from "bun:test";
import { installHostSkills, type HostSkillOptions } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { SourceError } from "../src/notion-source";
import type { ContentSearchRecord, ContentSearchResult } from "../src/content-search";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SkillRecord, SourceConfig } from "../src/types";
import { activeNotionSession } from "./fixtures/active-notion-session";

const candidate: ContentSearchRecord = {
  id: "skill://entry?library=controlled", kind: "skill", name: "Content candidate", alias: "entry",
  description: "Outside the default View.", enabled: true, default_context: false, entrypoint: "SKILL.md",
  ref: "skill://entry/SKILL.md?library=controlled",
  locator: { type: "shared_skill", library_id: "controlled", skill_id: "entry",
    page_id: "00000000-0000-4000-8000-000000000001", database_id: "00000000-0000-4000-8000-000000000002",
    data_source_id: "00000000-0000-4000-8000-000000000003" },
  match: { kind: "notion_remote_match", pageId: "00000000-0000-4000-8000-000000000001",
    representation: "projection", snippet: "Unique content needle." },
};
function result(records: ContentSearchRecord[] = [candidate]): ContentSearchResult {
  return { kind: "results", records, connection: { id: "selected-connection", grantEpoch: "grant-1" },
    resultId: "result-1", coverage: "remote_non_exhaustive", exhaustive: false, partial: false, notices: [] };
}
async function fixture(sources: SourceConfig[] = [{ id: "notion", type: "notion", library: "entry" }]) {
  const listeners = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const tools = new Map<string, Parameters<NonNullable<ExtensionAPI["registerTool"]>>[0]>();
  const branch: SessionEntry[] = [{ id: "user-1", type: "message", message: { role: "user", content: "Search my content." } }];
  let sessionId = "session-1", sessionFile = "/controlled/session-1.jsonl";
  let dispatches = 0, authorizations = 0, metadata = 0;
  let run: NonNullable<HostSkillOptions["contentSearch"]> = async () => result();
  let loadError: Error = new SourceError("ACCESS_DENIED", "notion");
  const records: SkillRecord[] = [0, 1].map(index => ({ ...candidate, id: nativeSkillId("controlled", String(index)),
    ref: nativeFileRef(nativeSkillId("controlled", String(index)), "SKILL.md"), name: "entry-" + index, alias: "entry-" + index,
    locator: { ...candidate.locator, skill_id: String(index), page_id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0") },
    source: "notion", sourceId: "notion", sourceScope: "a".repeat(64), defaultDiscovery: false,
    path: "/controlled/" + index + "/SKILL.md", normalizedName: "entry-" + index, normalizedAliases: [], normalizedDescription: "entry",
    aliases: [], autoloadEnabled: false }));
  const ctx: ExtensionContext = { cwd: "/controlled", hasUI: false, mode: "rpc", sessionManager: {
    getSessionId: () => sessionId, getSessionFile: () => sessionFile, getBranch: () => branch,
  } };
  const api: ExtensionAPI = {
    on(name, handler) { listeners.set(name, [...listeners.get(name) ?? [], handler]); },
    registerTool(tool) { tools.set(tool.name, tool); },
    appendEntry(customType, data) { branch.push({ id: "entry-" + branch.length, type: "custom", customType, data }); },
    getActiveTools: () => ["read", "notion_list", "notion_use"],
  };
  const adapter = createPiHostAdapter(api, async () => undefined);
  adapter.presentAuthorization = async request => {
    authorizations++;
    await new Promise<void>(resolve => {
      if (request.signal.aborted) resolve();
      else request.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
  const host = await installHostSkills(api, {
    config: { sources },
    getRecords: async () => {
      metadata++;
      const now = Date.now();
      return { records: records.map(record => ({ ...record, currentObservation: { origin: "remote", validatedAt: now, validUntil: now + 300_000 } })),
        failures: [], lists: [{ sourceId: "notion", scope: "a".repeat(64), exhaustive: true, policy: "max_age",
          validatedAt: new Date(now).toISOString(), ageMs: 0, maxAgeMs: 300_000, stale: false }] };
    },
    contentSearch: (...args) => { dispatches++; return run(...args); },
    loadRecord: async () => { throw loadError; },
  }, adapter);
  const emit = async (name: string) => { for (const handler of listeners.get(name) ?? []) await handler({ type: name } as never, ctx); };
  const list = (input: Record<string, unknown>, signal?: AbortSignal) => {
    const tool = tools.get("notion_list");
    if (!tool) throw new Error("Expected notion_list");
    return tool.execute("content-call", input, signal, undefined, ctx);
  };
  await emit("session_start");
  if (tools.has("notion_list")) await list({});
  return { ctx, branch, tools, sources, host, records, list, emit, adapter,
    setRun(value: typeof run) { run = value; }, setLoadError(value: Error) { loadError = value; },
    counts: () => ({ dispatches, authorizations, metadata }),
    session(id: string, file = sessionFile) { sessionId = id; sessionFile = file; },
    close: () => emit("session_shutdown"),
  };
}
const query = { search_in: "content", query: " Exact 中文 needle " };

test("default and explicit metadata queries and refresh never dispatch MCP or authorization", async () => {
  const f = await fixture();
  try {
    const baseline = await f.list({ query: "entry", limit: 1 });
    await f.list({ search_in: "metadata", query: "entry" });
    await f.list({ refresh: true });
    expect(baseline.details).toMatchObject({ count: 1, has_more: true, coverage: { exhaustive: true } });
    expect(f.counts()).toMatchObject({ dispatches: 0, authorizations: 0 });
  } finally { await f.close(); }
  for (const sources of [[], [{ id: "notion", type: "notion", enabled: false }]] satisfies SourceConfig[][]) {
    const disabled = await fixture(sources);
    try { expect([...disabled.tools.keys()]).not.toContain("notion_list"); expect(disabled.counts().dispatches).toBe(0); }
    finally { await disabled.close(); }
  }
});

test("content input admission requires one enabled source and rejects metadata cursors before MCP", async () => {
  const f = await fixture([{ id: "notion", type: "notion", library: "entry" }, { id: "other", type: "notion", library: "other-entry" }]);
  try {
    await expect(f.list(query)).rejects.toMatchObject({ code: "CONTENT_SOURCE_REQUIRED" });
    for (const input of [{ ...query, source: "notion", cursor: "0.abc" }, { ...query, source: "notion", limit: 51 },
      { search_in: "content", source: "notion", query: " " }, { ...query, source: "missing" }, { search_in: "unknown", query: "q" }])
      await expect(f.list(input)).rejects.toBeDefined();
    expect(f.counts().dispatches).toBe(0);
    const observed: string[] = [];
    f.setRun(async (input, source) => { observed.push(source); expect(input.query).toBe(query.query); return result(); });
    await f.list({ ...query, source: "other" });
    expect(observed).toEqual(["other"]);
  } finally { await f.close(); }
});

test("metadata pagination still works and mode switching cannot reuse its cursor for content", async () => {
  const f = await fixture();
  try {
    const first = (await f.list({ limit: 1 })).details;
    if (!first || typeof first !== "object" || !("next_cursor" in first) || typeof first.next_cursor !== "string") throw new Error("Expected metadata cursor");
    await expect(f.list({ ...query, cursor: first.next_cursor })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((await f.list({ search_in: "metadata", limit: 1, cursor: first.next_cursor })).details).toMatchObject({ count: 1, has_more: false });
    const searched = await f.list(query);
    expect(searched.details).toMatchObject({ search_in: "content", next_cursor: null, pagination: "not_supported", exhaustive: false });
    expect(f.counts().dispatches).toBe(1);
  } finally { await f.close(); }
});

test("authorization resumes the original query and source without appending selection or active entries", async () => {
  const f = await fixture(), before = structuredClone(f.branch);
  try {
    f.ctx.hasUI = true; f.ctx.mode = "tui";
    f.ctx.ui = { custom: async () => { throw new Error("The adapter owns the controlled presentation"); } };
    f.setRun(async (input, source, _ctx, options) => {
      expect(input).toEqual({ query: query.query, limit: 7 }); expect(source).toBe("notion");
      const presentation = new AbortController();
      const shown = options.onAuthorize?.({ url: "https://mcp.notion.com/authorize", signal: presentation.signal, deadline: options.deadline });
      expect(f.counts().authorizations).toBe(1);
      presentation.abort();
      await shown;
      return result();
    });
    const searched = await f.list({ ...query, limit: 7, refresh: true });
    expect(searched.details).toMatchObject({ ok: true, source: "notion", records: [{ availability: "available", match: { kind: "notion_remote_match" } }],
      coverage: "remote_non_exhaustive", exhaustive: false });
    expect(f.branch).toEqual(before);
  } finally { await f.close(); }
});

test("noninteractive searches omit the OAuth callback before the SDK can create a flight", async () => {
  const f = await fixture();
  try {
    for (const mode of ["rpc", "print", "json"] as const) {
      f.ctx.mode = mode; f.ctx.hasUI = true;
      f.ctx.ui = { custom: async () => { throw new Error("Noninteractive mode must not enter UI"); } };
      f.setRun(async (_input, _source, _ctx, options) => {
        expect(options.onAuthorize).toBeUndefined();
        throw Object.assign(new Error("No saved grant"), { code: "MCP_AUTH_REQUIRED" });
      });
      expect((await f.list(query)).details).toMatchObject({ state: "auth_required" });
    }
    expect(f.counts().authorizations).toBe(0);
    f.setRun(async (_input, _source, _ctx, options) => { expect(options.onAuthorize).toBeUndefined(); return result(); });
    expect((await f.list(query)).details).toMatchObject({ ok: true });
  } finally { await f.close(); }
});

for (const outcome of ["hit", "empty", "error"] as const) test("session navigation retires a non-cooperating remote " + outcome + " publication", async () => {
  const f = await fixture(), started = Promise.withResolvers<void>(), response = Promise.withResolvers<ContentSearchResult>();
  try {
    f.setRun(async () => { started.resolve(); return response.promise; });
    const operation = f.list(query), rejected = operation.then(() => undefined, error => error);
    await started.promise;
    await f.emit("session_before_tree");
    expect(await rejected).toMatchObject({ code: "SOURCE_CANCELLED" });
    if (outcome === "error") response.reject(Object.assign(new Error("PRIVATE_REMOTE_ERROR"), { code: "ACCESS_DENIED" }));
    else response.resolve(result(outcome === "empty" ? [] : [candidate]));
    await Promise.resolve();
  } finally { await f.close(); }
});

test("a later accepted REST denial retires an in-flight empty content result without rewriting pins", async () => {
  const f = await fixture(), started = Promise.withResolvers<void>(), response = Promise.withResolvers<ContentSearchResult>();
  try {
    f.setRun(async () => { started.resolve(); return response.promise; });
    const before = structuredClone(f.branch), operation = f.list(query), rejected = operation.then(() => undefined, error => error);
    await started.promise;
    await expect(f.host.activate(f.records[0]!, f.ctx)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    response.resolve(result([]));
    expect(await rejected).toMatchObject({ code: "SOURCE_CANCELLED" });
    expect(f.branch).toEqual(before);
  } finally { await f.close(); }
});

test("metadata refresh retires old content errors even when the catalog bytes do not change", async () => {
  const f = await fixture(), started = Promise.withResolvers<void>(), response = Promise.withResolvers<ContentSearchResult>();
  try {
    f.setRun(async () => { started.resolve(); return response.promise; });
    const operation = f.list(query), rejected = operation.then(() => undefined, error => error);
    await started.promise;
    await f.list({ refresh: true });
    expect(await rejected).toMatchObject({ code: "SOURCE_CANCELLED" });
    response.reject(Object.assign(new Error("PRIVATE_TOKEN"), { code: "MCP_AUTH_REQUIRED" }));
  } finally { await f.close(); }
});

test("a cancelled content waiter cannot cancel another valid waiter", async () => {
  const f = await fixture(), first = new AbortController(), responses = [Promise.withResolvers<ContentSearchResult>(), Promise.withResolvers<ContentSearchResult>()];
  let calls = 0;
  const started = Promise.withResolvers<void>();
  try {
    f.setRun(async () => { const response = responses[calls++]; if (calls === 2) started.resolve(); return response!.promise; });
    const one = f.list(query, first.signal), rejected = one.then(() => undefined, error => error);
    const two = f.list(query);
    await started.promise;
    first.abort(); expect(await rejected).toMatchObject({ code: "SOURCE_CANCELLED" });
    responses[1]!.resolve(result());
    expect((await two).details).toMatchObject({ ok: true });
    responses[0]!.resolve(result([]));
  } finally { await f.close(); }
});

test("source changes and an elapsed deadline reject late results before publication", async () => {
  for (const change of ["source", "session", "branch", "deadline"] as const) {
    const f = await fixture(), started = Promise.withResolvers<void>(), response = Promise.withResolvers<ContentSearchResult>();
    try {
      f.setRun(async () => { started.resolve(); return response.promise; });
      const operation = f.list(query);
      const rejected = operation.then(() => undefined, error => error);
      await started.promise;
      if (change === "source") f.sources[0]!.enabled = false;
      if (change === "session") f.session("another-session");
      if (change === "branch") f.branch[0] = { id: "different-user", type: "message" };
      if (change === "deadline") setSystemTime(Date.now() + 400_000);
      response.resolve(result([]));
      expect(await rejected).toMatchObject({ code: change === "deadline" ? "CONTENT_SEARCH_TIMEOUT" : "SOURCE_CANCELLED" });
    } finally { setSystemTime(); await f.close(); }
  }
});

test("remote failure output is bounded local wording, and MCP errors do not revoke REST task qualification", async () => {
  const f = await fixture();
  try {
    f.setRun(async () => { throw Object.assign(new Error("PRIVATE_TOKEN PRIVATE_CODE PRIVATE_VERIFIER"), {
      code: "MCP_AUTH_REQUIRED", details: { snippet: "UNADMITTED_CONTENT" } }); });
    const failed = await f.list(query);
    expect(failed.details).toMatchObject({ ok: false, state: "auth_required", error: { code: "MCP_AUTH_REQUIRED" }, exhaustive: false });
    expect(JSON.stringify(failed)).not.toContain("PRIVATE");
    expect(JSON.stringify(failed)).not.toContain("UNADMITTED");
    expect((await f.list({})).details).toMatchObject({ records: [{ availability: "available" }, { availability: "available" }] });
    f.setRun(async () => result([]));
    expect((await f.list(query)).details).toMatchObject({ ok: true, count: 0, exhaustive: false });
  } finally { await f.close(); }
});

test("source and branch changes retire remote failures before any error publication", async () => {
  for (const change of ["source", "branch"] as const) {
    const f = await fixture(), started = Promise.withResolvers<void>(), response = Promise.withResolvers<ContentSearchResult>();
    try {
      f.setRun(async () => { started.resolve(); return response.promise; });
      const operation = f.list(query), rejected = operation.then(() => undefined, error => error);
      await started.promise;
      if (change === "source") f.sources[0]!.library = "another-library";
      else f.branch[0] = { id: "another-branch", type: "message" };
      response.reject(Object.assign(new Error("PRIVATE_STALE_AUTH_DIAGNOSTIC"), { code: "MCP_AUTH_REQUIRED" }));
      const failure = await rejected;
      expect(failure).toMatchObject({ code: "SOURCE_CANCELLED" });
      expect(String(failure)).not.toContain("PRIVATE_STALE");
    } finally { await f.close(); }
  }
});

test("production index content search preserves existing active roots, Requires and every fixed pin", async () => {
  const f = await activeNotionSession();
  try {
    await f.seed(["root", "independent"]);
    const owner = f.f.record.locator;
    if (owner.type !== "shared_skill") throw new Error("Expected an admitted Notion owner");
    const found: ContentSearchRecord = { ...f.f.record, locator: owner, match: candidate.match };
    const before = { branch: structuredClone(f.branch), selected: structuredClone(f.selected()), active: structuredClone(f.active()) };
    const calls = f.f.calls.length;
    for (const outcome of ["hit", "empty", "error"] as const) {
      f.f.state.contentSearch = async (input, options) => {
        expect(input).toEqual({ query: query.query, limit: 5 });
        expect(options.library).toBe(f.f.source.library);
        expect(options.onAuthorize).toBeUndefined();
        expect(options.deadline).toBeGreaterThan(Date.now());
        if (outcome === "error") throw Object.assign(new Error("PRIVATE_MCP_ERROR"), { code: "MCP_AUTH_REQUIRED" });
        return result(outcome === "empty" ? [] : [found]);
      };
      const searched = await f.tool("notion_list").execute("content-" + outcome, { ...query, limit: 5, refresh: true }, undefined, undefined, f.ctx);
      expect(searched.details).toMatchObject({ ok: outcome !== "error", search_in: "content", exhaustive: false });
      expect(f.branch).toEqual(before.branch);
      expect(f.selected()).toEqual(before.selected);
      expect(f.active()).toEqual(before.active);
    }
    const operations = f.f.calls.slice(calls).map(call => call.operation);
    expect(operations.filter(operation => operation === "content-search")).toHaveLength(3);
    expect(operations.every(operation => operation === "list" || operation === "content-search")).toBe(true);
  } finally { await f.close(); }
});
