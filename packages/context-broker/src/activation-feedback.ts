import { randomUUID } from "node:crypto";
import { hostTextComponent } from "./host-text";
import type { ExtensionAPI, ExtensionContext, ExtensionWidgetNode, SkillRecord } from "./types";

export const ACTIVATION_MESSAGE = "context-broker-source-read";
const ACTIVATION_RESULT = "context-broker-source-read-result";
type ReadState = {
  id: string;
  target: string;
  source: string;
  status: "running" | "done" | "error";
  started: number;
  took?: number;
  version?: string;
  snapshot?: string;
  note: string;
};
function isReadState(value: unknown): value is ReadState {
  return !!value && typeof value === "object" && "id" in value && typeof value.id === "string" && "target" in value && typeof value.target === "string" && "status" in value;
}

export async function createActivationFeedback(api: ExtensionAPI, repaint: () => void) {
  const states = new Map<string, ReadState>();
  const Text = api.registerMessageRenderer ? await hostTextComponent(api) : undefined;
  api.registerMessageRenderer?.(ACTIVATION_MESSAGE, message => {
    if (!Text || !isReadState(message.details)) return undefined;
    const original = message.details;
    let collapsed = true;
    const current = () => states.get(original.id) ?? (original.status === "running" ? { ...original, status: "error" as const, note: "Interrupted before Skill preparation completed." } : original);
    const detail = (state: ReadState) => [`Source: ${state.source}`, state.version && `Version: ${state.version}`, state.snapshot && `Snapshot: ${state.snapshot}`, state.note].filter(Boolean).join("\n");
    return {
      render(width) {
        const state = current();
        return new Text([`Read ${state.target} · ${state.status}`, ...(collapsed ? [] : [detail(state)])].join("\n"), 0, 0).render(width);
      },
      invalidate() {},
      describe(surface) {
        if (!surface.supports("tool")) return null;
        const state = current();
        const terminalText = [`Read ${state.target} · ${state.status}`, detail(state)].join("\n");
        const node: ExtensionWidgetNode = {
          k: "tool",
          p: { name: "read", title: "Read", target: state.target, targetKind: "path", status: state.status, frame: "inline", collapsible: true, collapsed, preview: "none", note: state.note, terminalText, ...(state.status === "running" ? { age: Date.now() - state.started } : { took: state.took }) },
          c: [{ k: "text", p: { text: detail(state) } }],
        };
        return node;
      },
      handleNativeEvent(event) {
        if (event.type !== "toggle" || typeof event.collapsed !== "boolean") return;
        collapsed = event.collapsed;
        repaint();
      },
    };
  });
  return {
    restore(ctx: ExtensionContext) {
      states.clear();
      // Only the selected leaf's entries may supply final states for restored running rows.
      for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
        if (entry.type === "custom" && entry.customType === ACTIVATION_RESULT && isReadState(entry.data)) states.set(entry.data.id, entry.data);
      }
      repaint();
    },
    begin(record: SkillRecord, ctx?: ExtensionContext): ((result: { value: SkillRecord } | { error: string } | { skipped: true }) => void) | undefined {
      if (!ctx?.hasUI || !api.sendMessage || !api.registerMessageRenderer) return undefined;
      const session = ctx.sessionManager?.getSessionId?.();
      const token = record.token ?? record.name;
      const state: ReadState = { id: randomUUID(), target: `ntn-skills://${token.slice(token.indexOf("/") + 1)}`, source: record.sourceId ?? "source", status: "running", started: Date.now(), note: "Fetching the selected Skill and its resources." };
      states.set(state.id, state);
      api.sendMessage({ customType: ACTIVATION_MESSAGE, content: [], details: { ...state }, display: true }, { triggerTurn: false });
      repaint();
      return result => {
        if (state.status !== "running") return;
        state.status = "error" in result ? "error" : "done";
        state.took = Date.now() - state.started;
        state.note = "value" in result ? "Skill and resources ready." : "error" in result ? result.error : "Reference unavailable; original message retained.";
        if ("value" in result) { state.version = result.value.versionId; state.snapshot = result.value.snapshotId; }
        if (session === ctx.sessionManager?.getSessionId?.() && states.get(state.id) === state) {
          api.appendEntry?.(ACTIVATION_RESULT, { ...state });
          repaint();
        }
      };
    },
  };
}
