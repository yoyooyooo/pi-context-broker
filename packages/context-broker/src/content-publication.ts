import type { ExtensionContext } from "./types";

export type ContentPublicationState = {
  readonly task: number;
  readonly metadata: number;
  readonly qualification: number;
  /** The selected source's current configuration, not a display name. */
  readonly source: string | undefined;
};
const cancelled = () => Object.assign(new Error("SOURCE_CANCELLED"), { code: "SOURCE_CANCELLED" });
const timeout = () => Object.assign(new Error("CONTENT_SEARCH_TIMEOUT"), { code: "CONTENT_SEARCH_TIMEOUT" });
const branch = (ctx: ExtensionContext) => (ctx.sessionManager?.getBranch?.() ?? [])
  .map(entry => entry.id ?? JSON.stringify(entry));

/** One result owner covers hits, empty results, notices and errors alike. */
export function createContentPublication(input: {
  ctx: ExtensionContext;
  signal: AbortSignal;
  deadline: number;
  current(): ContentPublicationState;
  onQualificationChange(retire: () => void): () => void;
}) {
  const started = input.current();
  const sessionId = input.ctx.sessionManager?.getSessionId?.();
  const sessionFile = input.ctx.sessionManager?.getSessionFile?.();
  const ancestry = branch(input.ctx);
  const owner = new AbortController();
  const signal = AbortSignal.any([input.signal, owner.signal]);
  let closed = false;
  const retire = () => owner.abort();
  const unsubscribe = input.onQualificationChange(retire);
  const timer = setTimeout(retire, Math.max(0, input.deadline - Date.now()));
  function assertCurrent(): void {
    if (Date.now() >= input.deadline) throw timeout();
    const current = input.current();
    const currentBranch = branch(input.ctx);
    if (closed || signal.aborted || started.task !== current.task || started.metadata !== current.metadata
      || started.qualification !== current.qualification || started.source === undefined || started.source !== current.source
      || sessionId !== input.ctx.sessionManager?.getSessionId?.() || sessionFile !== input.ctx.sessionManager?.getSessionFile?.()
      || ancestry.length > currentBranch.length || ancestry.some((entry, index) => entry !== currentBranch[index]))
      throw cancelled();
  }
  return {
    signal,
    assertCurrent,
    async wait<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      assertCurrent();
      const interrupted = Promise.withResolvers<never>();
      const abort = () => interrupted.reject(Date.now() >= input.deadline ? timeout() : cancelled());
      signal.addEventListener("abort", abort, { once: true });
      try {
        const value = await Promise.race([work(signal), interrupted.promise]);
        assertCurrent();
        return value;
      } finally { signal.removeEventListener("abort", abort); }
    },
    close(): void {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
      owner.abort();
    },
  };
}
