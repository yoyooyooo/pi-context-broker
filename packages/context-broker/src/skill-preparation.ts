import { randomUUID } from "node:crypto";
import type { EditorLike, ExtensionContext, ImageContent, SkillRecord } from "./types";

export type PreparationContext = ExtensionContext;
export type PreparationInput = { text?: string; images?: ImageContent[] };
export type InputReceipt = {
  readonly id: string;
  readonly event: PreparationInput;
  readonly ctx: PreparationContext;
  readonly sessionId: string | undefined;
  readonly branch: readonly string[];
};
/** Called synchronously at input admission, including streaming queue admission. */
export function createInputReceipt(event: PreparationInput, ctx: PreparationContext): InputReceipt {
  return Object.freeze({ id: randomUUID(), event: structuredClone(event), ctx,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    branch: Object.freeze((ctx.sessionManager?.getBranch?.() ?? []).flatMap(entry => entry.id ? [entry.id] : [])) });
}
export type ActivePreparation = {
  readonly id: string;
  readonly receipt: InputReceipt;
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
export function isPreparationCancelled(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "SOURCE_ACTIVATION_CANCELLED";
}

/** Bound the whole host preparation, including producers that ignore AbortSignal. */
export async function withPreparationDeadline<T>(parent: AbortSignal, work: (signal: AbortSignal) => Promise<T>, timeoutMs = 60_000): Promise<T> {
  checkPreparationSignal(parent);
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const stopped = Promise.withResolvers<never>();
  const cancel = () => stopped.reject(preparationCancelled());
  parent.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    stopped.reject(Object.assign(new Error("Skill preparation timed out"), { code: "SOURCE_PREPARATION_TIMEOUT" }));
    controller.abort();
  }, timeoutMs);
  try { return await Promise.race([stopped.promise, work(signal)]); }
  finally { clearTimeout(timer); parent.removeEventListener("abort", cancel); }
}

/** Only the accepted context passes this capability to a guarded management
 * call. It changes accounting, never input authority or a writer's lifetime. */
export type ContextPreparationBudget = {
  waitForManagement<T>(work: () => Promise<T>): Promise<T>;
};

/** One Pi context shares cumulative read/management time across all accepted
 * inputs and roots. Ordinary tools keep withPreparationDeadline unchanged. */
export async function withContextPreparationDeadline<T>(
  parent: AbortSignal,
  work: (signal: AbortSignal, budget: ContextPreparationBudget) => Promise<T>,
): Promise<T> {
  checkPreparationSignal(parent);
  const controller = new AbortController(), signal = AbortSignal.any([parent, controller.signal]);
  const stopped = Promise.withResolvers<never>();
  const remaining = { read: 60_000, management: 180_000 }, started = performance.now();
  let phase: "read" | "management" | "closed" = "read", changedAt = started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { phase = "closed"; clearTimeout(timer); };
  const expire = () => {
    if (phase === "closed") return;
    close();
    stopped.reject(Object.assign(new Error("Skill preparation timed out"), { code: "SOURCE_PREPARATION_TIMEOUT" }));
    controller.abort();
  };
  const cancel = () => { close(); stopped.reject(preparationCancelled()); };
  parent.addEventListener("abort", cancel, { once: true });
  const charge = () => {
    const now = performance.now();
    if (phase !== "closed") {
      remaining[phase] -= Math.max(0, now - changedAt);
      if (remaining[phase] <= 0 || now - started >= 240_000) expire();
    }
    changedAt = now;
    return now;
  };
  const arm = (now: number) => {
    clearTimeout(timer);
    if (phase === "closed") return;
    const delay = Math.min(remaining[phase], 240_000 - (now - started));
    if (delay <= 0) expire();
    else timer = setTimeout(expire, delay);
  };
  const budget: ContextPreparationBudget = Object.freeze({
    async waitForManagement<T>(operation: () => Promise<T>): Promise<T> {
      // A closed capability, nested call or overlapping call cannot dispatch.
      if (phase !== "read") throw preparationCancelled();
      const now = charge();
      checkPreparationSignal(signal);
      phase = "management"; arm(now);
      checkPreparationSignal(signal);
      try { return await operation(); }
      finally {
        // The outer race retires foreground waiting. A late durable receipt is
        // still returned for fact invalidation; it cannot reopen this budget.
        if (phase === "management") {
          const now = charge();
          if (!signal.aborted) { phase = "read"; arm(now); }
        }
      }
    },
  });
  // Keep exactly the original single 60000ms timer when no manager is entered.
  arm(started);
  try {
    return await Promise.race([stopped.promise, (async () => {
      const result = await work(signal, budget);
      charge(); checkPreparationSignal(signal);
      return result;
    })()]);
  } finally { close(); parent.removeEventListener("abort", cancel); }
}

export function createPreparationGate(lockSubmission = true) {
  let active: ActivePreparation | undefined;
  let generation = 0;
  let editor: EditorLike | undefined;
  let priorDisabled = false;
  const wrapped = new WeakSet<EditorLike>();
  const repaint = () => { try { editor?.tui?.requestRender(); } catch { /* Optional UI does not own preparation. */ } };
  const release = (entry: ActivePreparation) => {
    if (active !== entry) return;
    active = undefined;
    if (editor && lockSubmission) editor.disableSubmit = priorDisabled;
    repaint();
  };
  const cancel = (abortHost = true) => {
    generation++;
    const entry = active;
    if (!entry) return;
    entry.controller.abort();
    if (entry.phase === "dispatching") {
      if (abortHost) entry.ctx.abort?.();
      // A void send may not have entered host setup yet. Its consumer must reject it
      // before a new submission can replace this sole receipt.
      repaint();
    } else release(entry);
  };
  const bind = (next: EditorLike) => {
    // Pi owns streaming input, its queue, and Stop. A Broker read must never
    // disable that editor or consume a second submission (including images).
    if (!lockSubmission) return next;
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
    begin(event: PreparationInput, ctx: PreparationContext, receipt = createInputReceipt(event, ctx)): ActivePreparation {
      if (active) throw new Error("A Skill submission is already preparing");
      generation++;
      const entry: ActivePreparation = { id: receipt.id, receipt, generation, prepared: new Map(), event: receipt.event, ctx: receipt.ctx,
        sessionId: receipt.sessionId, controller: new AbortController(), phase: "preparing", forwarded: false };
      active = entry;
      if (editor && lockSubmission) { priorDisabled = editor.disableSubmit ?? false; editor.disableSubmit = true; }
      repaint();
      return entry;
    },
    assertCurrent(entry: ActivePreparation, ctx: ExtensionContext = entry.ctx): void {
      checkPreparationSignal(entry.controller.signal);
      if (entry.generation !== generation || active !== entry || entry.sessionId !== ctx.sessionManager?.getSessionId?.() || entry.sessionId !== entry.ctx.sessionManager?.getSessionId?.()) throw preparationCancelled();
      const branch = ctx.sessionManager?.getBranch?.().flatMap(entry => entry.id ? [entry.id] : []);
      if (branch && entry.receipt.branch.some((id, index) => branch[index] !== id)) throw preparationCancelled();
    },
    bindEditor: bind,
  };
}
