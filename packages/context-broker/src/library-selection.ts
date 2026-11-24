import { notionPageId } from "./native-reference";
import { resolveNotionLibrarySdk, type SharedLibrary } from "./notion-sdk";
import type { ConfigFile, ExtensionAPI, ExtensionContext, SourceConfig } from "./types";

export const LIBRARY_SELECTION_ENTRY = "ntn-skills-library-selection";
type NotionSource = Extract<SourceConfig, { type: "notion" }>;
type Selection = { library: string | null; status: "requested" | "ready" }
  | { library: string | null; status: "blocked"; code: string };
export type ResolvedLibrarySelection = { library: SharedLibrary; source: NotionSource; sources: NotionSource[] };
export type LibraryContext = { readonly key: string; readonly selected: Promise<ResolvedLibrarySelection | undefined>; peek(): ResolvedLibrarySelection | undefined };
const contextKey = Symbol("context-broker.library");
type ScopedContext = ExtensionContext & { [contextKey]?: LibraryContext };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (code: string) => Object.assign(new Error(code), { code });
const codeOf = (error: unknown) => object(error) && typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)
  ? error.code : "LIBRARY_UNAVAILABLE";

/** The active branch is the only persisted session selection authority. */
export function sessionLibrary(ctx?: ExtensionContext): Selection & { entry?: string } {
  let selected: Selection & { entry?: string } = { library: null, status: "ready" };
  for (const entry of ctx?.sessionManager?.getBranch?.() ?? []) {
    if (entry.customType !== LIBRARY_SELECTION_ENTRY) continue;
    const data = entry.data;
    if (!object(data) || data.version !== 1 || data.library !== null
      && (typeof data.library !== "string" || notionPageId(data.library) !== data.library)
      || data.status !== "requested" && data.status !== "ready" && data.status !== "blocked"
      || data.status === "blocked" && (typeof data.code !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(data.code)))
      throw failure("LIBRARY_SELECTION_INVALID");
    selected = data.status === "blocked"
      ? { library: data.library as string | null, status: "blocked", code: data.code as string, entry: entry.id }
      : { library: data.library as string | null, status: data.status, entry: entry.id };
  }
  return selected;
}

export function libraryContext(ctx?: ExtensionContext): LibraryContext | undefined {
  return (ctx as ScopedContext | undefined)?.[contextKey];
}
export function inheritLibraryContext(ctx: ExtensionContext, accepted?: ExtensionContext): ExtensionContext {
  const library = libraryContext(accepted);
  return library ? { ...ctx, [contextKey]: library } : ctx;
}

/** Source IDs carry Broker policy. Core owns selection, defaults and binding verification. */
export function createLibrarySelection(config: ConfigFile, resolveLibrary = resolveNotionLibrarySdk) {
  const contexts = new Map<string, LibraryContext>();
  let revision = 0;
  async function resolveSelection(selection: Selection, ctx: ExtensionContext): Promise<ResolvedLibrarySelection | undefined> {
    if (selection.status === "blocked") throw failure(selection.code);
    const sources = (config.sources ?? []).filter((source): source is NotionSource => source.type === "notion" && source.enabled !== false);
    if (!sources.length && selection.library === null) return undefined;
    const options = { cwd: ctx.cwd ?? process.cwd(), env: { ...process.env } };
    const defaultLibrary = selection.library === null || sources.some(source => source.library === undefined)
      ? await resolveLibrary(options) : undefined;
    const library = selection.library === null ? defaultLibrary! : await resolveLibrary({ ...options, library: selection.library });
    if (selection.library !== null && library.library_id !== selection.library) throw failure("LIBRARY_SCOPE_MISMATCH");
    const bound = sources.map(source => {
      const id = source.library === undefined ? defaultLibrary?.library_id : notionPageId(source.library);
      if (!id) throw failure("SOURCE_CONFIG_INVALID");
      return { ...source, library: id };
    });
    if (new Set(bound.map(source => source.library)).size !== bound.length) throw failure("LIBRARY_SOURCE_AMBIGUOUS");
    const source = bound.find(source => source.library === library.library_id);
    if (!source) throw failure("LIBRARY_SOURCE_UNAVAILABLE");
    return { library, source, sources: bound };
  }
  function capture(ctx: ExtensionContext = {}): ExtensionContext {
    if (libraryContext(ctx)) return ctx;
    const selection = sessionLibrary(ctx);
    const key = JSON.stringify([ctx.cwd ?? process.cwd(), revision, selection]);
    let captured = contexts.get(key);
    if (!captured) {
      let resolved: ResolvedLibrarySelection | undefined;
      captured = { key, selected: resolveSelection(selection, ctx).then(value => { resolved = value; return value; }), peek: () => resolved };
      // Input acceptance starts the read even when Pi has not entered agent_start.
      // Keep rejection observable by its consumer without an unhandled-rejection side effect.
      void captured.selected.catch(() => undefined);
      contexts.set(key, captured);
    }
    return { ...ctx, [contextKey]: captured };
  }
  const selected = (ctx: ExtensionContext = {}) => libraryContext(capture(ctx))!.selected;
  return {
    capture, selected,
    key: (ctx?: ExtensionContext) => libraryContext(capture(ctx))!.key,
    isCurrent(ctx: ExtensionContext) {
      const captured = libraryContext(ctx);
      return captured === undefined || captured.key === libraryContext(capture({ ...ctx, [contextKey]: undefined }))!.key;
    },
    invalidate() { revision++; contexts.clear(); },
    async sources(ctx?: ExtensionContext) { return (await selected(ctx))?.sources ?? []; },
    async verify(source: NotionSource, ctx: ExtensionContext) {
      const library = await resolveLibrary({ library: source.library, cwd: ctx.cwd ?? process.cwd(), env: { ...process.env }, signal: ctx.signal });
      if (source.library !== undefined && library.library_id !== notionPageId(source.library)) throw failure("LIBRARY_SCOPE_MISMATCH");
      return library;
    },
    async route(library: string, ctx: ExtensionContext) {
      const sources = (config.sources ?? []).filter((source): source is NotionSource => source.type === "notion" && source.enabled !== false);
      const defaultLibrary = sources.some(source => source.library === undefined)
        ? await resolveLibrary({ cwd: ctx.cwd ?? process.cwd(), env: { ...process.env } }) : undefined;
      const matches = sources.filter(source => (source.library === undefined ? defaultLibrary?.library_id : notionPageId(source.library)) === library)
        .map(source => ({ ...source, library }));
      if (matches.length > 1) throw failure("LIBRARY_SOURCE_AMBIGUOUS");
      if (!matches.length) throw failure("LIBRARY_SOURCE_UNAVAILABLE");
      return matches;
    },
    async config(ctx?: ExtensionContext): Promise<ConfigFile> {
      const sources = await this.sources(ctx);
      return { ...config, sources: [...(config.sources ?? []).filter(source => source.type !== "notion"), ...sources] };
    },
  };
}
export type LibrarySelectionOwner = ReturnType<typeof createLibrarySelection>;

export function createLibraryCommand(api: ExtensionAPI, owner: LibrarySelectionOwner, refresh: (ctx: ExtensionContext) => Promise<void>) {
  let generation = 0;
  const invalidate = () => { generation++; };
  for (const event of ["session_before_switch", "session_before_tree", "session_before_branch", "session_shutdown"] as const) api.on(event, invalidate);
  return async (args: string, ctx: ExtensionContext): Promise<boolean> => {
    const [command, target, ...extra] = args.trim().split(/\s+/);
    if (command !== "library") return false;
    if (extra.length) { ctx.ui?.notify?.("Usage: /context-broker library [ROOT_ID|NOTION_URL|default]", "error"); return true; }
    if (target === undefined) {
      try {
        const selected = await owner.selected(ctx);
        ctx.ui?.notify?.(selected ? `Library ${selected.library.library_id} · source ${selected.source.id}` : "No enabled Notion sources", "info");
      } catch (error) { ctx.ui?.notify?.(`Library unavailable (${codeOf(error)}). Select an accessible Library explicitly.`, "error"); }
      return true;
    }
    const library = target === "default" ? null : notionPageId(target);
    if (library === undefined || !api.appendEntry) {
      ctx.ui?.notify?.("Choose a Library root page ID or Notion URL in a host supporting session entries.", "error"); return true;
    }
    const requested = ++generation, session = ctx.sessionManager?.getSessionId?.();
    const current = () => requested === generation && session === ctx.sessionManager?.getSessionId?.();
    // Persist intent first. An unavailable B must never fall back to A for a later write.
    api.appendEntry(LIBRARY_SELECTION_ENTRY, { version: 1, library, status: "requested" });
    owner.invalidate();
    try {
      const selected = await owner.selected(ctx);
      if (!current()) return true;
      api.appendEntry(LIBRARY_SELECTION_ENTRY, { version: 1, library, status: "ready" });
      owner.invalidate();
      await refresh(owner.capture(ctx));
      if (current()) ctx.ui?.notify?.(`Library ${selected?.library.library_id ?? "default"} selected for subsequent submissions. Accepted tasks and fixed Skill versions retain their original Library.`, "info");
    } catch (error) {
      if (!current()) return true;
      api.appendEntry(LIBRARY_SELECTION_ENTRY, { version: 1, library, status: "blocked", code: codeOf(error) });
      owner.invalidate();
      await refresh(owner.capture(ctx));
      if (current()) ctx.ui?.notify?.(`Library switch failed (${codeOf(error)}). This branch stays blocked until a Library is selected successfully.`, "error");
    }
    return true;
  };
}
