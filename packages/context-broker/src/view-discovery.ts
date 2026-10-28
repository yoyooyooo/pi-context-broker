import { recordIdentity } from "./discovery-records";
import { discoverNotionSource, listNotionViews, SourceError } from "./notion-source";
import type { ConfigFile, DiscoveryResult, ExtensionAPI, ExtensionContext, NotionViewState, SkillRecord, SourceConfig } from "./types";

export const VIEW_SELECTION_ENTRY = "ntn-skills-view-selection";
type NotionSource = Extract<SourceConfig, { type: "notion" }>;
const enabledSources = (config: ConfigFile): NotionSource[] => (config.sources ?? []).filter((source): source is NotionSource => source.type === "notion" && source.enabled !== false);

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function sessionViews(ctx?: ExtensionContext): Map<string, string> {
  const overrides = new Map<string, string>();
  // Active-branch entries, rather than a process/global last-selection variable,
  // define inheritance across fork, rewind, resume and new sessions.
  for (const entry of ctx?.sessionManager?.getBranch?.() ?? []) {
    if (entry.customType !== VIEW_SELECTION_ENTRY || !object(entry.data)) continue;
    const data = entry.data;
    if (data.version !== 1 || typeof data.sourceId !== "string" || (data.viewId !== null && typeof data.viewId !== "string")) continue;
    if (data.viewId === null) overrides.delete(data.sourceId);
    else overrides.set(data.sourceId, data.viewId);
  }
  return overrides;
}

export async function resolveViewDiscovery(config: ConfigFile, catalog: DiscoveryResult<SkillRecord>, ctx?: ExtensionContext, signal?: AbortSignal): Promise<DiscoveryResult<SkillRecord>> {
  const records = new Map(catalog.records.map(record => [recordIdentity(record), { ...record, defaultDiscovery: record.source !== "notion" }]));
  const failures = catalog.failures.map(failure => ({ ...failure }));
  const views: NotionViewState[] = [];
  const overrides = sessionViews(ctx);
  for (const source of enabledSources(config)) {
    signal?.throwIfAborted();
    const selector = overrides.get(source.id) ?? source.default_view_id;
    const origin = overrides.has(source.id) ? "session" : source.default_view_id !== undefined ? "configured" : "first";
    try {
      const selected = await discoverNotionSource(source, ctx?.cwd ?? process.cwd(), { signal, ...(selector === undefined ? { defaultView: true } : { view: selector }) });
      signal?.throwIfAborted();
      // Only associate rows observed under the same credential scope.
      const scopes = new Set(catalog.records.filter(record => record.sourceId === source.id).map(record => record.sourceScope));
      if (scopes.size && selected.some(record => !scopes.has(record.sourceScope))) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
      for (const record of selected) {
        const identity = recordIdentity(record);
        records.set(identity, { ...(records.get(identity) ?? record), defaultDiscovery: record.kind !== "prompt" });
      }
      // A complete View can still deliver exact records when full-library discovery
      // has unrelated failures. Retain the warning; do not turn it into an ACL.
      for (const failure of failures) if (failure.sourceId === source.id) failure.blocking = false;
      failures.push(...selected.failures);
      views.push(selected.view ? { sourceId: source.id, origin, status: "ready", view: selected.view, count: selected.filter(record => record.kind !== "prompt").length, partial: selected.failures.length > 0 } : { sourceId: source.id, origin, status: "empty" });
    } catch (error) {
      if (signal?.aborted) throw error;
      const code = error instanceof SourceError ? error.code : "SOURCE_VIEW_UNAVAILABLE";
      views.push({ sourceId: source.id, origin, status: "error", code });
      failures.push({ sourceId: source.id, namespace: source.namespace ?? source.id, type: "notion", code, blocking: false, message: "Default View unavailable. Use /context-broker views and /context-broker view to choose an accessible View. Explicit Skill discovery is unchanged." });
    }
  }
  return { ...catalog, records: [...records.values()], failures, views };
}

export function formatViewStatus(views: readonly NotionViewState[]): string {
  if (!views.length) return "Notion Views: no enabled Notion sources";
  return views.map(state => state.status === "ready"
    ? `${state.sourceId}: ${state.view.name} (${state.view.id}) · ${state.count} Skill/Router · ${state.origin}${state.partial ? " · partial" : ""}`
    : `${state.sourceId}: ${state.status === "empty" ? "no Views; empty default directory" : `default View failed (${state.code})`} · ${state.origin}`).join("\n");
}

export function createViewCommands(api: ExtensionAPI, config: ConfigFile, refresh: (ctx: ExtensionContext) => Promise<void>, status: () => readonly NotionViewState[]) {
  let generation = 0;
  let controller = new AbortController();
  const invalidate = () => { generation++; controller.abort(); controller = new AbortController(); };
  for (const event of ["session_before_switch", "session_before_tree", "session_before_branch", "session_shutdown"] as const) api.on(event, invalidate);
  const sourceFor = (id?: string) => {
    const sources = enabledSources(config);
    const source = id === undefined && sources.length === 1 ? sources[0] : sources.find(source => source.id === id);
    if (!source) throw new Error(`Select one Notion source: ${sources.map(source => source.id).join(", ") || "none configured"}`);
    return source;
  };
  return async (args: string, ctx: ExtensionContext): Promise<boolean> => {
    const [command, ...parts] = args.trim().split(/\s+/);
    if (command !== "view" && command !== "views") return false;
    try {
      if (command === "view" && !parts.length) { ctx.ui?.notify?.(formatViewStatus(status()), "info"); return true; }
      if (command === "views") {
        if (parts.length > 1) throw new Error("Usage: /context-broker views [source-id]");
        const source = sourceFor(parts[0]);
        const views = await listNotionViews(source, ctx.cwd ?? process.cwd(), controller.signal);
        ctx.ui?.notify?.([`Views for ${source.id} (API order):`, ...views.map((view, index) => `${index + 1}. ${view.name}\n  /context-broker view ${source.id} ${view.id}`), views.length ? "" : "No Views; the default directory is empty."].join("\n"), "info");
        return true;
      }
      if (parts.length < 1 || parts.length > 2) throw new Error("Usage: /context-broker view [source-id] <view-id|Notion-URL|default>");
      const source = sourceFor(parts.length === 2 ? parts[0] : undefined);
      const selector = parts.at(-1)!;
      if (!api.appendEntry) throw new Error("The host does not support persisted session View selection.");
      invalidate();
      const selectedGeneration = generation;
      const session = ctx.sessionManager?.getSessionId?.();
      const requested = selector === "default" ? source.default_view_id : selector;
      const result = await discoverNotionSource(source, ctx.cwd ?? process.cwd(), { signal: controller.signal, refresh: true, ...(requested === undefined ? { defaultView: true } : { view: requested }) });
      if (selectedGeneration !== generation || session !== ctx.sessionManager?.getSessionId?.()) return true;
      // Validate before persisting; an invalid explicit choice never silently changes
      // the previous working selection or the user's configuration file.
      api.appendEntry(VIEW_SELECTION_ENTRY, { version: 1, sourceId: source.id, viewId: selector === "default" ? null : result.view?.id ?? requested });
      await refresh(ctx);
      if (selectedGeneration === generation) ctx.ui?.notify?.(`${formatViewStatus(status())}\nApplies to the next user submission. Already loaded Skill bodies keep their snapshots.`, "info");
    } catch (error) {
      if (!controller.signal.aborted) ctx.ui?.notify?.(error instanceof Error ? error.message : "View selection failed", "error");
    }
    return true;
  };
}
