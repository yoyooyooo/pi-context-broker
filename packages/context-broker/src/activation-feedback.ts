import { randomUUID } from "node:crypto";
import { hostTextComponent, type HostTextConstructor } from "./host-text";
import { singleLine } from "./pi-display";
import type { ExtensionAPI, ExtensionContext, ExtensionRenderOptions, ExtensionWidgetComponent, ExtensionWidgetNode, SkillRecord, SourceConfig } from "./types";

export const ACTIVATION_MESSAGE = "context-broker-source-read";
const ACTIVATION_RESULT = "context-broker-source-read-result";
type ReadState = {
  id: string;
  target: string;
  source: string;
  status: "running" | "done" | "error";
  started: number;
  name?: string;
  namespace?: "notion" | "local";
  purpose?: "use" | "inspect";
  delivered?: boolean;
  limits?: string;
  took?: number;
  version?: string;
  snapshot?: string;
  note: string;
};
type Result = { value: SkillRecord } | { error: string } | { skipped: true };
type LiveRead = { state: ReadState; ctx: ExtensionContext; session: string | undefined };
type Theme = { fg(color: string, value: string): string; bg?(color: string, value: string): string };
const plainTheme: Theme = { fg: (_color, value) => value };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isTheme = (value: unknown): value is Theme => object(value) && typeof value.fg === "function" && (value.bg === undefined || typeof value.bg === "function");
function isReadState(value: unknown): value is ReadState {
  return object(value) && typeof value.id === "string" && typeof value.target === "string"
    && typeof value.source === "string" && typeof value.started === "number" && Number.isFinite(value.started)
    && (value.status === "running" || value.status === "done" || value.status === "error") && typeof value.note === "string"
    && (value.name === undefined || typeof value.name === "string")
    && (value.namespace === undefined || value.namespace === "notion" || value.namespace === "local")
    && (value.purpose === undefined || value.purpose === "use" || value.purpose === "inspect")
    && (value.delivered === undefined || typeof value.delivered === "boolean")
    && (value.took === undefined || typeof value.took === "number" && Number.isFinite(value.took))
    && [value.limits, value.version, value.snapshot].every(item => item === undefined || typeof item === "string");
}
function status(state: ReadState): string {
  if (state.status === "running") return "loading…";
  if (state.status === "error") return state.note === "Cancelled." ? "cancelled" : "unavailable";
  return state.purpose === "use" ? state.delivered ? "loaded" : "ready" : "read";
}
function heading(state: ReadState, theme: Theme, expandKey?: string): string {
  return theme.fg("customMessageLabel", `\x1b[1m[skill${state.namespace === "local" ? "" : "@notion"}]\x1b[22m `)
    + theme.fg("customMessageText", singleLine(state.name ?? state.target.replace(/^ntn-skills:\/\//, "")))
    + theme.fg(state.status === "error" && state.note !== "Cancelled." ? "warning" : "dim", ` · ${status(state)}`)
    + (expandKey ? theme.fg("dim", ` (${singleLine(expandKey)} to expand)`) : "");
}
function detail(state: ReadState): string {
  return [state.note, `Source: ${state.source}`, state.limits, state.version && `Version: ${state.version}`,
    state.snapshot && `Snapshot: ${state.snapshot}`].filter(Boolean).join("\n");
}

export async function createActivationFeedback(api: ExtensionAPI, repaint: () => void, presentation: "message" | "entry" = "message") {
  const states = new Map<string, ReadState>(), live = new Map<string, LiveRead>();
  let Text: HostTextConstructor | undefined;
  if (api.registerEntryRenderer || api.registerMessageRenderer) {
    try { Text = await hostTextComponent(api); } catch { /* Optional UI cannot prevent a user turn. */ }
  }
  // Display delivery is best effort. It must never turn a successful acquisition
  // or an ordinary source warning into a failed user submission.
  const display = (operation: () => unknown) => { try { void Promise.resolve(operation()).catch(() => {}); } catch { /* Host UI unavailable. */ } };
  const repaintDisplay = () => display(repaint);
  const isCurrent = (entry: LiveRead) => live.get(entry.state.id) === entry
    && entry.session === entry.ctx.sessionManager?.getSessionId?.();
  const publish = (entry: LiveRead) => {
    // Pi's entry_appended event repaints the existing transcript component even
    // when this state-only entry has no renderer. No editor widget is involved.
    display(() => api.appendEntry?.(ACTIVATION_RESULT, { ...entry.state }));
    repaintDisplay();
  };
  const finish = (entry: LiveRead, result: Result) => {
    if (entry.state.status !== "running" || !isCurrent(entry)) return;
    const state = entry.state;
    state.status = "value" in result ? "done" : "error";
    state.took = Date.now() - state.started;
    state.note = "value" in result ? "Skill and resources ready." : "error" in result ? result.error : "Reference unavailable; original message retained.";
    if ("value" in result) { state.version = result.value.versionId; state.snapshot = result.value.snapshotId; }
    publish(entry);
    if (state.status === "done" && state.purpose !== "use") live.delete(state.id);
  };
  const render = (data: unknown, options: ExtensionRenderOptions, themeValue: unknown): ExtensionWidgetComponent | undefined => {
    if (!Text || !isReadState(data)) return undefined;
    const RenderText = Text, original = data;
    const theme = isTheme(themeValue) ? themeValue : plainTheme;
    let collapsed = !options.expanded;
    const current = () => states.get(original.id) ?? (original.status === "running"
      ? { ...original, status: "error" as const, note: "Interrupted before Skill preparation completed." } : original);
    return {
      render(width) {
        const state = current();
        const background = theme.bg?.bind(theme);
        return new RenderText([heading(state, theme, collapsed ? options.keyText?.("app.tools.expand") : undefined),
          ...(collapsed ? [] : [detail(state)])].join("\n"), options.outputPad ?? 1, 1,
          background ? value => background(state.status === "done" ? "toolSuccessBg" : "toolPendingBg", value) : undefined).render(width);
      },
      invalidate() {},
      describe(surface) {
        if (!surface.supports("tool")) return null;
        const state = current();
        const node: ExtensionWidgetNode = {
          k: "tool",
          p: { name: "read", title: "[skill@notion]", target: state.name ?? state.target, targetKind: "path", status: state.status,
            frame: "inline", collapsible: true, collapsed, preview: "none", note: state.note,
            terminalText: [heading(state, plainTheme), detail(state)].join("\n"),
            ...(state.status === "running" ? { age: Date.now() - state.started } : { took: state.took }) },
          c: [{ k: "text", p: { text: detail(state) } }],
        };
        return node;
      },
      handleNativeEvent(event) {
        if (event.type !== "toggle" || typeof event.collapsed !== "boolean") return;
        collapsed = event.collapsed;
        repaintDisplay();
      },
    };
  };
  display(() => api.registerEntryRenderer?.(ACTIVATION_MESSAGE, (entry, options, theme) => render(entry.data, options, theme)));
  // Existing message records and the other host keep the same display history.
  display(() => api.registerMessageRenderer?.(ACTIVATION_MESSAGE, (message, options, theme) => render(message.details, options, theme)));
  return {
    restore(ctx: ExtensionContext) {
      live.clear(); states.clear();
      // Only the selected leaf's entries may supply final states for restored running rows.
      for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
        if (entry.type === "custom" && entry.customType === ACTIVATION_RESULT && isReadState(entry.data)) states.set(entry.data.id, entry.data);
      }
      repaintDisplay();
    },
    begin(selected: SkillRecord | readonly SkillRecord[], ctx?: ExtensionContext, purpose?: "use" | "inspect", source?: SourceConfig): ((result: Result) => void) | undefined {
      if (!ctx?.hasUI) return undefined;
      if (!Text || (presentation === "entry" ? !api.appendEntry || !api.registerEntryRenderer : !api.sendMessage || !api.registerMessageRenderer)) return undefined;
      const records: readonly SkillRecord[] = "name" in selected ? [selected] : selected;
      const record = records[0];
      if (!record) return undefined;
      const session = ctx.sessionManager?.getSessionId?.();
      for (const [id, previous] of live) if (previous.session === session && previous.state.status === "error") live.delete(id);
      const token = record.token ?? record.name;
      const budget = source?.type === "notion" ? source.preparation : undefined;
      const limits = purpose ? `Limits: up to ${budget?.maxNodes ?? 64} nodes, depth ${budget?.maxDepth ?? 16}, ${budget?.maxInstructionBytes ?? 1048576} instruction bytes, ${budget?.maxContextBytes ?? 262144} context bytes.` : undefined;
      const state: ReadState = { id: randomUUID(), target: `ntn-skills://${token.slice(token.indexOf("/") + 1)}`,
        name: [...new Set(records.map(item => item.name))].join(", "), namespace: record.source === "notion" || source?.type === "notion" ? "notion" : "local", source: record.sourceId ?? "source",
        status: "running", started: Date.now(), purpose, limits, note: "Loading selected Skill instructions. Stop cancels preparation." };
      const entry: LiveRead = { state, ctx, session };
      states.set(state.id, state); live.set(state.id, entry);
      // A custom entry appears immediately in Pi's chat transcript, including
      // during context preparation. It is display-only and never queues a turn.
      if (presentation === "entry") display(() => api.appendEntry?.(ACTIVATION_MESSAGE, { ...state }));
      else display(() => api.sendMessage?.({ customType: ACTIVATION_MESSAGE, content: [], details: { ...state }, display: true }, { triggerTurn: false }));
      repaintDisplay();
      return result => finish(entry, result);
    },
    confirmPrepared(ctx: ExtensionContext) {
      const session = ctx.sessionManager?.getSessionId?.();
      for (const entry of live.values()) if (entry.session === session && entry.state.status === "done" && entry.state.purpose === "use") {
        entry.state.delivered = true;
        entry.state.note = "Skill instructions loaded for this request.";
        publish(entry); live.delete(entry.state.id);
      }
    },
    failPending(ctx: ExtensionContext, message: string): boolean {
      const session = ctx.sessionManager?.getSessionId?.();
      let found = false;
      for (const entry of live.values()) if (entry.session === session) {
        found = true;
        entry.state.status = "error"; entry.state.note = message; entry.state.took = Date.now() - entry.state.started;
        publish(entry); live.delete(entry.state.id);
      }
      return found;
    },
    clearPending(ctx: ExtensionContext) {
      const session = ctx.sessionManager?.getSessionId?.();
      for (const entry of live.values()) if (entry.session === session) {
        // Stop cancels unfinished preparation, not an already prepared request.
        if (entry.state.status === "running") {
          entry.state.status = "error"; entry.state.note = "Cancelled.";
          entry.state.took = Date.now() - entry.state.started;
          publish(entry);
        }
        live.delete(entry.state.id);
      }
    },
  };
}
