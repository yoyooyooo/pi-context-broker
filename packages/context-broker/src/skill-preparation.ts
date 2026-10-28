import { randomUUID } from "node:crypto";
import type { EditorLike, ExtensionContext, ImageContent, SkillRecord } from "./types";

export type PreparationContext = ExtensionContext;
export type PreparationInput = { text?: string; images?: ImageContent[] };
export type ActivePreparation = {
  readonly id: string;
  readonly generation: number;
  readonly prepared: Map<string, SkillRecord>;
  readonly event: PreparationInput;
  readonly ctx: PreparationContext;
  readonly sessionId: string | undefined;
  readonly controller: AbortController;
  phase: "preparing" | "dispatching";
  forwarded: boolean;
};

export function preparationCancelled(): Error {
  return Object.assign(new Error("Skill preparation cancelled"), { code: "SOURCE_ACTIVATION_CANCELLED" });
}
export function checkPreparationSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw preparationCancelled();
}

export function createPreparationGate() {
  let active: ActivePreparation | undefined;
  let generation = 0;
  let editor: EditorLike | undefined;
  let priorDisabled = false;
  const wrapped = new WeakSet<EditorLike>();
  const repaint = () => editor?.tui?.requestRender();
  const release = (entry: ActivePreparation) => {
    if (active !== entry) return;
    active = undefined;
    if (editor) editor.disableSubmit = priorDisabled;
    repaint();
  };
  const cancel = () => {
    generation++;
    const entry = active;
    if (!entry) return;
    entry.controller.abort();
    if (entry.phase === "dispatching") {
      entry.ctx.abort?.();
      // A void send may not have entered host setup yet. Its consumer must reject it
      // before a new submission can replace this sole receipt.
      repaint();
    } else release(entry);
  };
  const bind = (next: EditorLike) => {
    if (editor !== next) {
      editor = next;
      if (!active) priorDisabled = next.disableSubmit ?? false;
    }
    if (active) next.disableSubmit = true;
    if (wrapped.has(next)) return next;
    wrapped.add(next);
    const input = next.handleInput?.bind(next);
    next.handleInput = data => {
      if (active) {
        if (data === "\x1b" || data === "\x03" || /^\x1b\[(?:27;5;99~|99;5u|27u)$/.test(data)) { cancel(); return; }
        next.disableSubmit = true;
      }
      input?.(data);
    };
    const native = next.handleNativeEvent?.bind(next);
    next.handleNativeEvent = event => {
      if (active) {
        if (event.act === "interrupt") { cancel(); return; }
        if (event.type === "send" || event.act === "submit") return;
        next.disableSubmit = true;
      }
      native?.(event);
    };
    const layout = next.describeLayout?.bind(next);
    if (layout) next.describeLayout = (...args) => {
      const hostState = next.composerState;
      if (!active || !hostState) return layout(...args);
      // The host assigns composerState after factory construction. Project only while describing.
      next.composerState = () => ({ ...hostState(), running: true });
      try { return layout(...args); }
      finally { next.composerState = hostState; }
    };
    return next;
  };
  return {
    get active() { return active; },
    repaint,
    cancel,
    release,
    begin(event: PreparationInput, ctx: PreparationContext): ActivePreparation {
      if (active) throw new Error("A Skill submission is already preparing");
      generation++;
      const entry: ActivePreparation = { id: randomUUID(), generation, prepared: new Map(), event: { ...event, images: event.images?.slice() }, ctx, sessionId: ctx.sessionManager?.getSessionId?.(), controller: new AbortController(), phase: "preparing", forwarded: false };
      active = entry;
      if (editor) { priorDisabled = editor.disableSubmit ?? false; editor.disableSubmit = true; }
      repaint();
      return entry;
    },
    assertCurrent(entry: ActivePreparation, ctx: ExtensionContext = entry.ctx): void {
      checkPreparationSignal(entry.controller.signal);
      if (entry.generation !== generation || active !== entry || entry.sessionId !== ctx.sessionManager?.getSessionId?.() || entry.sessionId !== entry.ctx.sessionManager?.getSessionId?.()) throw preparationCancelled();
    },
    bindEditor: bind,
  };
}
