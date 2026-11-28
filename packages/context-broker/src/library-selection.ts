import { notionPageId } from "./native-reference";
import { selectNotionLibrarySdk, resolveNotionLibrarySdk, type SharedLibrary } from "./notion-sdk";
import type { ConfigFile, ExtensionAPI, ExtensionContext, SourceConfig } from "./types";

export const LIBRARY_SELECTION_ENTRY = "ntn-skills-library-selection";
type NotionSource = Extract<SourceConfig, { type: "notion" }>;
type Selection = { library: string | null; status: "requested" | "ready" }
  | { library: string | null; status: "blocked"; code: string };
export type ResolvedLibrarySelection = { library: SharedLibrary; source: NotionSource; sources: NotionSource[] };
type LibraryIdentity = { root: string; source: NotionSource; sources: NotionSource[] };
export type LibraryContext = { readonly key: string; readonly identity: Promise<LibraryIdentity | undefined>; readonly selected: Promise<ResolvedLibrarySelection | undefined>;
  local(): LibraryIdentity | null | undefined };
const contextKey = Symbol("context-broker.library");
type ScopedContext = ExtensionContext & { [contextKey]?: LibraryContext };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (code: string) => Object.assign(new Error(code), { code });
const codeOf = (error: unknown) => object(error) && typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)
  ? error.code : "LIBRARY_UNAVAILABLE";

/** The active branch is the only persisted session selection authority. */
export function sessionLibrary(ctx?: ExtensionContext): Selection & { entry?: string } {
  const entry = (ctx?.sessionManager?.getBranch?.() ?? []).filter(entry => entry.customType === LIBRARY_SELECTION_ENTRY).at(-1);
  if (!entry) return { library: null, status: "ready" };
  const data = entry.data;
  if (!object(data) || data.version !== 1 || data.library !== null
    && (typeof data.library !== "string" || notionPageId(data.library) !== data.library)
    || data.status !== "requested" && data.status !== "ready" && data.status !== "blocked"
    || data.status === "blocked" && (typeof data.code !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(data.code)))
    throw failure("LIBRARY_SELECTION_INVALID");
  return data.status === "blocked"
    ? { library: data.library as string | null, status: "blocked", code: data.code as string, entry: entry.id }
    : { library: data.library as string | null, status: data.status, entry: entry.id };
}

export function libraryContext(ctx?: ExtensionContext): LibraryContext | undefined {
  return (ctx as ScopedContext | undefined)?.[contextKey];
}
export function inheritLibraryContext(ctx: ExtensionContext, accepted?: ExtensionContext): ScopedContext {
  const library = libraryContext(accepted);
  return library ? { ...ctx, [contextKey]: library } : ctx;
}

/** Source IDs carry Broker policy. Core owns selection, defaults and binding verification. */
export function createLibrarySelection(config: ConfigFile, resolveLibrary = resolveNotionLibrarySdk, selectLibrary = selectNotionLibrarySdk) {
  const contexts = new Map<string, LibraryContext>();
  const verified = new Map<string, Promise<SharedLibrary>>();
  let revision = 0, admission = 0;
  const sources = () => (config.sources ?? []).filter((source): source is NotionSource => source.type === "notion" && source.enabled !== false);
  const sdkOptions = (ctx: ExtensionContext) => ({ cwd: ctx.cwd ?? process.cwd(), env: { ...process.env } });
  function verifyRoot(root: string, ctx: ExtensionContext) {
    const options = sdkOptions(ctx), key = JSON.stringify([options.cwd, root]);
    let pending = verified.get(key);
    if (!pending) {
      pending = resolveLibrary({ ...options, library: root }).then(library => {
        if (library.library_id !== root) throw failure("LIBRARY_SCOPE_MISMATCH");
        return library;
      });
      verified.set(key, pending);
      void pending.catch(() => { if (verified.get(key) === pending) verified.delete(key); });
    }
    return pending;
  }
  async function select(selection: Selection, ctx: ExtensionContext) {
    if (selection.status === "blocked") throw failure(selection.code);
    const configured = sources();
    if (!configured.length && selection.library === null) return undefined;
    const options = sdkOptions(ctx);
    const defaultRoot = selection.library === null || configured.some(source => source.library === undefined)
      ? await selectLibrary(options) : undefined;
    const root = selection.library === null ? defaultRoot! : await selectLibrary({ ...options, library: selection.library });
    if (selection.library !== null && root !== selection.library) throw failure("LIBRARY_SCOPE_MISMATCH");
    const bound = configured.map(source => {
      const id = source.library === undefined ? defaultRoot : notionPageId(source.library);
      if (!id) throw failure("SOURCE_CONFIG_INVALID");
      return { ...source, library: id };
    });
    if (new Set(bound.map(source => source.library)).size !== bound.length) throw failure("LIBRARY_SOURCE_AMBIGUOUS");
    const source = bound.find(source => source.library === root);
    if (!source) throw failure("LIBRARY_SOURCE_UNAVAILABLE");
    return { root, defaultRoot, source, sources: bound };
  }
  function capture(ctx: ScopedContext = {}, fresh = false): ScopedContext {
    if (!fresh && libraryContext(ctx)) return ctx;
    const selection = sessionLibrary(ctx);
    const base = JSON.stringify([ctx.cwd ?? process.cwd(), revision, selection]);
    let captured = fresh ? undefined : contexts.get(base);
    if (!captured) {
      let key = JSON.stringify([base, "pending", ++admission]);
      let local: LibraryIdentity | null | undefined;
      let selected: Promise<ResolvedLibrarySelection | undefined> | undefined;
      const identity = select(selection, ctx).then(value => {
        key = JSON.stringify([base, value?.root ?? null, value?.defaultRoot ?? null]);
        local = value ?? null;
        return value;
      });
      captured = { get key() { return key; }, identity, local: () => local,
        get selected() {
          if (!selected) {
            // Routing needs only local configuration. SDK consumption owns the
            // freshness check; explicit Library inspection still verifies it.
            selected = identity.then(async value => value ? {
              library: await verifyRoot(value.root, ctx), source: value.source, sources: value.sources,
            } : undefined);
            void selected.catch(() => undefined);
          }
          return selected;
        } };
      // Input acceptance precedes its consumer; observe local-selection errors.
      void captured.identity.catch(() => undefined);
      contexts.set(base, captured);
    }
    return { ...ctx, [contextKey]: captured };
  }
  const selected = (ctx: ExtensionContext = {}) => libraryContext(capture(ctx))!.selected;
  const identity = (ctx: ExtensionContext = {}) => libraryContext(capture(ctx))!.identity;
  return {
    capture: (ctx?: ExtensionContext) => capture(ctx), selected, identity,
    accept: (ctx: ExtensionContext) => capture(ctx, true),
    key: (ctx?: ExtensionContext) => libraryContext(capture(ctx))!.key,
    isCurrent(ctx: ExtensionContext) {
      const captured = libraryContext(ctx);
      return captured === undefined || captured.key === libraryContext(capture({ ...ctx, [contextKey]: undefined }))!.key;
    },
    invalidate() { revision++; contexts.clear(); verified.clear(); },
    async sources(ctx?: ExtensionContext) { return (await identity(ctx))?.sources ?? []; },
    async verify(source: NotionSource, ctx: ExtensionContext) {
      const library = await resolveLibrary({ library: source.library, cwd: ctx.cwd ?? process.cwd(), env: { ...process.env }, signal: ctx.signal });
      if (source.library !== undefined && library.library_id !== notionPageId(source.library)) throw failure("LIBRARY_SCOPE_MISMATCH");
      return library;
    },
    async route(library: string, ctx: ExtensionContext) {
      const captured = libraryContext(ctx);
      if (captured) {
        // Full refs can still target an explicit enabled Source on a blocked branch.
        // A successful local selection keeps an implicit Source bound to this turn.
        await captured.identity.catch(() => undefined);
        const local = captured.local();
        if (local) {
          const matches = local.sources.filter(source => source.library === library);
          if (!matches.length) throw failure("LIBRARY_SOURCE_UNAVAILABLE");
          return matches;
        }
      }
      const configured = sources();
      const defaultRoot = configured.some(source => source.library === undefined)
        ? await selectLibrary(sdkOptions(ctx)) : undefined;
      const matches = configured.filter(source => (source.library === undefined ? defaultRoot : notionPageId(source.library)) === library)
        .map(source => ({ ...source, library }));
      if (matches.length > 1) throw failure("LIBRARY_SOURCE_AMBIGUOUS");
      if (!matches.length) throw failure("LIBRARY_SOURCE_UNAVAILABLE");
      return matches;
    },
    async config(ctx?: ExtensionContext): Promise<ConfigFile> {
      const current = await identity(ctx);
      return { ...config, sources: [...(config.sources ?? []).filter(source => source.type !== "notion"), ...(current ? [current.source] : [])] };
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
