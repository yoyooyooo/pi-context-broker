import { stripVTControlCharacters } from "node:util";
import type { ReadDisplaySnapshot } from "./read-display";
import type { PiReadDefinition } from "./types";

type ReadRenderers = Pick<PiReadDefinition, "renderCall" | "renderResult">;
type DisplayLookup = (input: { args: Record<string, unknown>; toolCallId: string }) => ReadDisplaySnapshot | undefined;
type ReadTheme = { fg(color: string, text: string): string };
type ReadContext = Record<string, unknown> & { state: object; keyText(action: string): unknown };
type MutableText = { setText(text: string): void };
type Header = { component: MutableText; args: Record<string, unknown>; theme: ReadTheme; context: ReadContext; customized: boolean };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isTheme = (value: unknown): value is ReadTheme => object(value) && typeof value.fg === "function";
const isContext = (value: unknown): value is ReadContext => object(value) && object(value.state) && typeof value.keyText === "function";
const isMutableText = (value: unknown): value is MutableText => object(value) && typeof value.setText === "function";

function singleLine(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/gu, " ").trim();
}

// Display details are persisted session data. Validate their version and binding
// to the original arguments before using them; names never resolve a read.
function readDisplay(value: unknown, args: Record<string, unknown>): ReadDisplaySnapshot | undefined {
  if (!object(value) || value.version !== 1 || value.source !== "notion"
    || typeof value.name !== "string" || !singleLine(value.name)
    || typeof value.sourceId !== "string" || !value.sourceId.trim() || typeof value.scope !== "string" || !value.scope.trim()
    || value.sourceLabel !== undefined && typeof value.sourceLabel !== "string") return undefined;
  const base = { version: 1, source: "notion", name: value.name, sourceId: value.sourceId, scope: value.scope,
    ...(typeof value.sourceLabel === "string" ? { sourceLabel: value.sourceLabel } : {}),
  } satisfies Pick<ReadDisplaySnapshot, "version" | "source" | "name" | "sourceId" | "scope" | "sourceLabel">;
  if (value.kind === "skill") {
    if (typeof value.ref !== "string" || !value.ref || args.path !== value.ref || args.paths !== undefined) return undefined;
    return { ...base, kind: "skill", ref: value.ref };
  }
  if (value.kind !== "file" || !Array.isArray(value.files) || value.files.length === 0) return undefined;
  const files: Array<{ ref: string; path: string }> = [];
  for (const file of value.files) {
    if (!object(file) || typeof file.ref !== "string" || !file.ref || typeof file.path !== "string" || !singleLine(file.path)) return undefined;
    files.push({ ref: file.ref, path: file.path });
  }
  const refs = typeof args.path === "string" && args.paths === undefined ? [args.path]
    : args.path === undefined && Array.isArray(args.paths) ? args.paths : [];
  if (refs.length !== files.length || files.some((file, index) => file.ref !== refs[index])) return undefined;
  return { ...base, kind: "file", files };
}

function lineNumber(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function lineRange(args: Record<string, unknown>): string {
  if (args.offset == null && args.limit == null) return "";
  const start = args.offset == null ? 1 : lineNumber(args.offset);
  if (start === undefined) return "";
  if (args.limit == null) return `:${start}`;
  const count = lineNumber(args.limit);
  if (count === undefined) return "";
  const end = start + count - 1;
  return `:${start}${end ? `-${end}` : ""}`;
}

function title(display: ReadDisplaySnapshot, header: Header): string {
  const { theme, context, args } = header;
  let label = singleLine(display.name);
  if (display.kind === "file") {
    const first = display.files[0];
    if (first) label += ` / ${singleLine(first.path)}`;
    if (display.files.length > 1) label += ` (+${display.files.length - 1} ${display.files.length === 2 ? "file" : "files"})`;
  }
  const range = lineRange(args);
  const source = display.sourceLabel && singleLine(display.sourceLabel);
  const key = context.keyText("app.tools.expand");
  return theme.fg("customMessageLabel", `\x1b[1m[${display.kind}@notion]\x1b[22m `)
    + theme.fg("customMessageText", label)
    + (range ? theme.fg("warning", range) : "")
    + (source ? theme.fg("dim", ` · ${source}`) : "")
    + (typeof key === "string" && key ? theme.fg("dim", ` (${singleLine(key)} to expand)`) : "");
}

const nativeArgs = (args: Record<string, unknown>): Record<string, unknown> => Array.isArray(args.paths)
  ? { path: args.paths.join(", ") } : args;

/** Decorate Pi's own read header, retaining its component, shell and result renderer. */
export function createPiReadRenderers({ native, getDisplay }: { native: ReadRenderers; getDisplay?: DisplayLookup }): ReadRenderers {
  const renderCall = native.renderCall, renderResult = native.renderResult;
  if (!renderCall) return {};
  const headers = new WeakMap<object, Header>();
  return {
    renderCall(args, theme, context) {
      const component = renderCall(nativeArgs(args), theme, context);
      if (!isContext(context) || !isTheme(theme) || !isMutableText(component)) return component;
      const header: Header = { component, args, theme, context, customized: false };
      headers.set(context.state, header);
      // A completed/replayed call must use its saved result, never today's catalog.
      if (!context.expanded && context.executionStarted === true && context.isPartial === true && typeof context.toolCallId === "string") {
        const display = readDisplay(getDisplay?.({ args, toolCallId: context.toolCallId }), args);
        if (display) { component.setText(title(display, header)); header.customized = true; }
      }
      return component;
    },
    ...(renderResult ? { renderResult(result, options, theme, context) {
      const component = renderResult(result, options, theme, context);
      if (!isContext(context)) return component;
      const header = headers.get(context.state);
      if (!header || context.expanded) return component;
      const hasSnapshot = object(result.details) && Object.hasOwn(result.details, "contextBrokerReadDisplay");
      const display = readDisplay(object(result.details) ? result.details.contextBrokerReadDisplay : undefined, header.args);
      if (display) {
        header.component.setText(title(display, header));
        header.customized = true;
      } else if (header.customized && (hasSnapshot || context.isPartial !== true)) {
        renderCall(nativeArgs(header.args), header.theme, { ...header.context, lastComponent: header.component });
        header.customized = false;
      }
      // Pi renders call before result. Updating that same Text here also covers
      // the first replay frame, without another render or any metadata I/O.
      return component;
    } } satisfies ReadRenderers : {}),
  };
}
