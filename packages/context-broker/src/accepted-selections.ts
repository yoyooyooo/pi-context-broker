import type { InputReceipt } from "./skill-preparation";
import type { ExtensionContext } from "./types";

/** Input admission consumes draft choices. Cancellation never identifies input. */
export function createAcceptedSelections<T>(tokenOf: (candidate: T) => string) {
  const sessions = new Map<string, Map<string, T>>();
  const submissions = new WeakMap<InputReceipt, ReadonlyMap<string, T>>();
  const key = (ctx: ExtensionContext) => JSON.stringify([ctx.cwd ?? process.cwd(), ctx.sessionManager?.getSessionId?.() ?? ""]);
  return {
    remember(ctx: ExtensionContext, record: T): void {
      const scope = key(ctx);
      const choices = sessions.get(scope) ?? new Map<string, T>();
      choices.set(tokenOf(record), structuredClone(record));
      sessions.set(scope, choices);
    },
    capture(receipt: InputReceipt, queries: Iterable<string>): void {
      if (submissions.has(receipt)) return;
      const scope = key(receipt.ctx), draft = sessions.get(scope);
      const frozen = new Map<string, T>();
      for (const query of queries) {
        const record = draft?.get(query);
        if (!record) continue;
        frozen.set(query, record);
        draft!.delete(query);
      }
      if (draft?.size === 0) sessions.delete(scope);
      submissions.set(receipt, frozen);
    },
    forSubmission(receipt?: InputReceipt): ReadonlyMap<string, T> {
      return receipt ? submissions.get(receipt) ?? new Map() : new Map();
    },
    forContext(ctx: ExtensionContext): ReadonlyMap<string, T> {
      return sessions.get(key(ctx)) ?? new Map();
    },
    clear(ctx: ExtensionContext): void {
      sessions.delete(key(ctx));
    },
  };
}
