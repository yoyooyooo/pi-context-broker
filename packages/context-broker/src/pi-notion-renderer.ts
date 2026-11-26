import { singleLine } from "./pi-display";
import { isSkillPreparationModel, type SkillPreparationModel, type SkillPreparationModelDirectory } from "./skill-context-projection";
import type { NativeReadResult, NativeToolRenderers } from "./types";

type RenderComponent = { render(width: number): readonly string[]; invalidate(): void };
type RenderText = RenderComponent & { setText(text: string): void };
type RenderContainer = RenderComponent & { addChild(component: RenderComponent): void };
export type NotionRendererUi = {
  Text: new(text: string, paddingX: number, paddingY: number) => RenderText;
  Markdown: new(text: string, paddingX: number, paddingY: number, theme: unknown) => RenderComponent;
  Container: new() => RenderContainer;
  getMarkdownTheme(): unknown;
};
export type PiNotionRenderers = { list: NativeToolRenderers; use: NativeToolRenderers };
type Theme = { fg(color: string, text: string): string };
type Context = Record<string, unknown> & { state: object; keyText(action: string): unknown };
type Header = { component: RenderText; args: Record<string, unknown> };
type ListRecord = { name: string; description: string; ref: string; source: string; availability: string;
  error_code?: string; in_default_view?: boolean; match?: { title?: string; snippet?: string; representation: string } };
type ListView = { records: ListRecord[]; summary: string; warning: boolean; notes: string[] };
type Failure = { state: string; message: string };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isTheme = (value: unknown): value is Theme => object(value) && typeof value.fg === "function";
const isContext = (value: unknown): value is Context => object(value) && object(value.state) && typeof value.keyText === "function";
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const clip = (value: string, length = 140) => { const chars = Array.from(singleLine(value)); return chars.length > length ? chars.slice(0, length).join("") + "…" : chars.join(""); };
const plainTheme: Theme = { fg: (_color, text) => text };

function listRecord(value: unknown): ListRecord | undefined {
  if (!object(value) || typeof value.name !== "string" || typeof value.description !== "string" || typeof value.ref !== "string"
    || typeof value.source !== "string" || typeof value.availability !== "string"
    || value.error_code !== undefined && typeof value.error_code !== "string") return undefined;
  let match: ListRecord["match"];
  if (value.match !== undefined) {
    if (!object(value.match) || typeof value.match.representation !== "string"
      || value.match.title !== undefined && typeof value.match.title !== "string"
      || value.match.snippet !== undefined && typeof value.match.snippet !== "string") return undefined;
    match = { representation: value.match.representation,
      ...(typeof value.match.title === "string" ? { title: value.match.title } : {}),
      ...(typeof value.match.snippet === "string" ? { snippet: value.match.snippet } : {}) };
  }
  return { name: value.name, description: value.description, ref: value.ref, source: value.source, availability: value.availability,
    ...(typeof value.error_code === "string" ? { error_code: value.error_code } : {}),
    ...(typeof value.in_default_view === "boolean" ? { in_default_view: value.in_default_view } : {}), ...(match ? { match } : {}) };
}

function listView(value: unknown): ListView | undefined {
  if (!object(value) || value.ok !== true || value.state !== "known" || !Array.isArray(value.records)
    || !natural(value.count) || value.count !== value.records.length) return undefined;
  const records: ListRecord[] = [];
  for (const record of value.records) { const parsed = listRecord(record); if (!parsed) return undefined; records.push(parsed); }
  const count = `${records.length} ${records.length === 1 ? "result" : "results"}`;
  if (value.search_in === "content") {
    if (value.coverage !== "remote_non_exhaustive" || value.exhaustive !== false || typeof value.partial !== "boolean"
      || value.pagination !== "not_supported" || value.next_cursor !== null || !Array.isArray(value.notices)) return undefined;
    const notes = ["Content search · non-exhaustive · no pagination", "Remote matches do not prove exact Skill or resource bytes; no results do not establish absence."];
    for (const notice of value.notices) {
      if (!object(notice) || typeof notice.code !== "string" || typeof notice.message !== "string") return undefined;
      notes.push(`${singleLine(notice.code)}: ${singleLine(notice.message)}`);
    }
    return { records, summary: `${count} · ${value.partial ? "partial results" : "non-exhaustive"}`, warning: value.partial, notes };
  }
  if (value.search_in !== undefined && value.search_in !== "metadata" || !natural(value.total_count) || value.total_count < records.length
    || typeof value.has_more !== "boolean" || value.next_cursor !== null && typeof value.next_cursor !== "string"
    || !object(value.coverage) || !Array.isArray(value.coverage.sources)
    || !object(value.freshness) || !Array.isArray(value.freshness.sources) || !Array.isArray(value.failures)) return undefined;
  if (value.has_more ? typeof value.next_cursor !== "string" || !value.next_cursor.trim() || value.total_count <= records.length
    : value.next_cursor !== null) return undefined;
  const notes: string[] = [];
  const coverage = new Map<string, unknown>(), freshness = new Map<string, { policy: unknown; stale: unknown }>();
  for (const source of value.coverage.sources) {
    if (!object(source) || typeof source.source !== "string" || coverage.has(source.source)) return undefined;
    coverage.set(source.source, source.exhaustive);
  }
  for (const source of value.freshness.sources) {
    if (!object(source) || typeof source.source !== "string" || freshness.has(source.source)) return undefined;
    freshness.set(source.source, { policy: source.policy, stale: source.stale });
    const state = source.policy === "offline" || source.policy === "pinned" ? source.policy : source.stale === true ? "stale" : source.stale === false ? "fresh" : "unknown freshness";
    notes.push(`${singleLine(source.source)} · ${state} · coverage ${coverage.get(source.source) === true ? "exhaustive" : coverage.get(source.source) === false ? "partial" : "unknown"}`);
  }
  for (const failure of value.failures) {
    if (!object(failure) || typeof failure.source !== "string" || typeof failure.code !== "string") return undefined;
    notes.push(`${singleLine(failure.source)} · failed: ${singleLine(failure.code)}`);
  }
  const sourcesMatch = coverage.size > 0 && coverage.size === freshness.size && [...coverage.keys()].every(source => freshness.has(source));
  const complete = sourcesMatch && value.coverage.exhaustive === true && [...coverage.values()].every(exhaustive => exhaustive === true) && value.failures.length === 0;
  const fresh = sourcesMatch && [...freshness.values()].every(source => ["default", "max_age", "refresh"].includes(String(source.policy)) && source.stale === false);
  const qualifiers: string[] = [];
  if (!complete) qualifiers.push(value.failures.length || value.coverage.exhaustive === false ? "partial results" : "coverage unknown");
  if ([...freshness.values()].some(source => source.policy === "offline")) qualifiers.push("offline");
  else if ([...freshness.values()].some(source => source.policy === "pinned")) qualifiers.push("pinned metadata");
  else if ([...freshness.values()].some(source => source.stale === true)) qualifiers.push("stale metadata");
  else if (!fresh) qualifiers.push("freshness unknown");
  const summary = records.length === 0 && value.total_count === 0 && !value.has_more && complete && fresh ? "no matches"
    : value.total_count > records.length ? `${records.length} of ${value.total_count} results` : count;
  if (value.has_more) qualifiers.push("more available");
  if (value.next_cursor) notes.push(`Next cursor: ${singleLine(value.next_cursor)}`);
  return { records, summary: [summary, ...qualifiers].join(" · "), warning: !complete || !fresh, notes };
}

function failure(value: unknown, isError: boolean, raw: string): Failure | undefined {
  if (!isError && (!object(value) || value.ok !== false)) return undefined;
  const state = object(value) && (typeof value.state === "string" ? value.state : typeof value.status === "string" ? value.status : undefined);
  const label = state === "cancelled" ? "cancelled" : state === "auth_required" ? "authorization required" : state === "unsupported" ? "unsupported" : "failed";
  const error = object(value) ? value.error : undefined;
  const message = typeof error === "string" ? error : object(error)
    ? [typeof error.code === "string" ? error.code : "", typeof error.message === "string" ? error.message : ""].filter(Boolean).join(": ") : raw;
  return { state: label, message: clip(message, 240) || label };
}

function requestedLabel(kind: "list" | "use", args: Record<string, unknown>): string {
  if (kind === "list") return (typeof args.query === "string" && singleLine(args.query) || "Skills") + (args.search_in === "content" ? " · content" : "");
  const refs = typeof args.ref === "string" ? [args.ref] : Array.isArray(args.ref) ? args.ref.filter((value): value is string => typeof value === "string") : [];
  return (refs[0] ? singleLine(refs[0]) : "Skills") + (refs.length > 1 ? ` (+${refs.length - 1} roots)` : "");
}
function loadedLabel(model: SkillPreparationModel): string {
  const roots = [...new Set(model.roots)], first = model.records.find(record => record.ref === roots[0]);
  return singleLine(first?.name ?? "Skills") + (roots.length > 1 ? ` (+${roots.length - 1} ${roots.length === 2 ? "root" : "roots"})` : "");
}
function headerText(kind: "list" | "use", label: string, status: string, warning: boolean, expanded: boolean, theme: Theme, context: unknown): string {
  const key = isContext(context) ? context.keyText("app.tools.expand") : undefined;
  return theme.fg("customMessageLabel", `\x1b[1m[${kind === "list" ? "list" : "skill"}@notion]\x1b[22m `)
    + theme.fg("customMessageText", label) + (status ? theme.fg(warning ? "warning" : "dim", ` · ${status}`) : "")
    + (!expanded && typeof key === "string" && key ? theme.fg("dim", ` (${singleLine(key)} to expand)`) : "");
}

/** A pure view of saved tool content. It never resolves refs or changes delivery. */
export function createPiNotionRenderers(ui: NotionRendererUi): PiNotionRenderers {
  function create(kind: "list" | "use"): NativeToolRenderers {
    const headers = new WeakMap<object, Header>();
    const decoded = new WeakMap<object, { raw: string; value: unknown }>();
    const text = (value: string) => new ui.Text(value, 0, 0);
    function read(result: NativeReadResult) {
      const cached = decoded.get(result.content); if (cached) return cached;
      const raw = result.content.map(block => block.type === "text" && typeof block.text === "string" ? block.text : "[image]").join("\n");
      let value: unknown;
      if (result.content.length === 1 && result.content[0]?.type === "text") { try { value = JSON.parse(raw); } catch { /* Native errors and older sessions remain readable. */ } }
      const parsed = { raw, value }; decoded.set(result.content, parsed); return parsed;
    }
    function directory(container: RenderContainer, value: SkillPreparationModelDirectory, theme: Theme) {
      if (value.files.length) {
        container.addChild(text(theme.fg("customMessageLabel", `\nResources · ${value.files.length} files`)));
        for (const file of value.files) container.addChild(text(`${singleLine(file.path)}\n${theme.fg("dim", singleLine(file.ref))}${file.description ? "\n" + singleLine(file.description) : ""}`));
      }
      for (const [label, relations] of [["Requires", value.required], ["Candidates", value.candidates], ["References", value.references]] as const) {
        if (!relations.length) continue;
        container.addChild(text(theme.fg("customMessageLabel", `\n${label}`)));
        for (const relation of relations) container.addChild(text("name" in relation
          ? `${singleLine(relation.name)} · ${singleLine(relation.availability)}\n${theme.fg("dim", singleLine(relation.ref))}${relation.description ? "\n" + singleLine(relation.description) : ""}`
          : theme.fg("dim", singleLine(relation.ref))));
      }
    }
    return {
      renderCall(args, themeValue, context) {
        const theme = isTheme(themeValue) ? themeValue : plainTheme;
        const component = text(headerText(kind, requestedLabel(kind, args), object(context) && context.isPartial === true ? "loading…" : "", false,
          object(context) && context.expanded === true, theme, context));
        if (isContext(context)) headers.set(context.state, { component, args });
        return component;
      },
      renderResult(result, options, themeValue, context) {
        const theme = isTheme(themeValue) ? themeValue : plainTheme;
        const expanded = object(options) && options.expanded === true, isPartial = object(options) && options.isPartial === true;
        const isError = object(context) && context.isError === true || result.isError === true;
        const row = isContext(context) ? headers.get(context.state) : undefined;
        const args = object(context) && object(context.args) ? context.args : row?.args ?? {};
        const { raw, value } = read(result), failed = failure(value, isError, raw);
        const list = !isPartial && !failed && kind === "list" ? listView(value) : undefined;
        const use = !isPartial && !failed && kind === "use" && isSkillPreparationModel(value) && value.purpose === "use" ? value : undefined;
        let status = failed?.state ?? (isPartial ? "loading…" : list?.summary ?? "");
        if (use) {
          const roots = new Set(use.roots), required = new Set(use.records.filter(record => !roots.has(record.ref)).map(record => record.ref)).size;
          status = (args.refresh === true ? "reloaded" : "loaded") + (required ? ` (+${required} required)` : "");
        }
        row?.component.setText(headerText(kind, use ? loadedLabel(use) : requestedLabel(kind, args), status,
          Boolean(failed) || list?.warning === true, expanded, theme, context));
        const container = new ui.Container();
        if (failed) container.addChild(text(expanded ? raw : theme.fg("error", failed.message)));
        else if (isPartial) container.addChild(text(theme.fg("dim", kind === "list" ? "Searching Notion Skills…" : "Loading Skill instructions…")));
        else if (list) {
          const shown = expanded ? list.records : list.records.slice(0, 3);
          for (const record of shown) {
            const duplicate = list.records.filter(other => other.name === record.name).length > 1;
            container.addChild(text(theme.fg("customMessageText", singleLine(record.name))
              + (expanded || duplicate ? theme.fg("dim", ` · ${singleLine(record.source)}`) : "")
              + (expanded || record.availability !== "available" ? theme.fg(record.availability === "available" ? "dim" : "warning", ` · ${singleLine(record.availability)}`) : "")));
            if (record.error_code) container.addChild(text(theme.fg("warning", singleLine(record.error_code))));
            if (record.description) container.addChild(text(theme.fg("dim", expanded ? singleLine(record.description) : clip(record.description))));
            if (expanded) {
              container.addChild(text(theme.fg("dim", singleLine(record.ref))));
              if (record.in_default_view === false) container.addChild(text(theme.fg("dim", "Outside default view")));
              if (record.match) {
                container.addChild(text(theme.fg("dim", `Match: ${singleLine(record.match.representation)}${record.match.title ? " · " + singleLine(record.match.title) : ""}`)));
                if (record.match.snippet) container.addChild(text(singleLine(record.match.snippet)));
              }
            }
          }
          if (!expanded && list.records.length > shown.length) container.addChild(text(theme.fg("dim", `+${list.records.length - shown.length} more in this page`)));
          if (expanded) for (const note of list.notes) container.addChild(text(theme.fg(list.warning ? "warning" : "dim", note)));
          else if (list.warning) {
            const warnings = list.notes.filter(note => /failed:|offline|pinned|stale|unknown|partial|^[A-Z_]+:/.test(note));
            for (const note of warnings.slice(0, 3)) container.addChild(text(theme.fg("warning", clip(note, 180))));
            if (warnings.length > 3) container.addChild(text(theme.fg("dim", `+${warnings.length - 3} more source notices`)));
          }
        } else if (use) {
          if (expanded) {
            const roots = new Set(use.roots);
            for (const record of use.records) {
              container.addChild(text(theme.fg("customMessageLabel", `${singleLine(record.name)} · ${roots.has(record.ref) ? "root" : "required"}`)));
              container.addChild(text(theme.fg("dim", singleLine(record.ref))));
              container.addChild(new ui.Markdown(record.content, 0, 0, ui.getMarkdownTheme()));
              if (record.directory) directory(container, record.directory, theme);
            }
          }
        } else container.addChild(text(raw));
        return container;
      },
    };
  }
  return { list: create("list"), use: create("use") };
}

const TUI_PACKAGE_NAME = "@earendil-works/pi-tui", PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export async function loadPiNotionRenderers(): Promise<PiNotionRenderers | undefined> {
  try {
    const [tui, pi]: unknown[] = await Promise.all([import(TUI_PACKAGE_NAME), import(PI_PACKAGE_NAME)]);
    if (!object(tui) || typeof tui.Text !== "function" || typeof tui.Markdown !== "function" || typeof tui.Container !== "function"
      || !object(pi) || typeof pi.getMarkdownTheme !== "function") return undefined;
    // These are the host's public component constructors, checked at the optional package boundary.
    const ui = { Text: tui.Text, Markdown: tui.Markdown, Container: tui.Container, getMarkdownTheme: pi.getMarkdownTheme } as NotionRendererUi;
    return createPiNotionRenderers(ui);
  } catch { return undefined; }
}
