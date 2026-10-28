import { recordToken } from "./discovery-records";
import type { DiscoveryRecord, ExtensionContext } from "./types";

/** Draft choices transfer to the existing preparation's signal before any await. */
export function createAcceptedSelections() {
  const sessions = new Map<string, Map<string, DiscoveryRecord>>();
  const submissions = new WeakMap<AbortSignal, ReadonlyMap<string, DiscoveryRecord>>();
  const key = (ctx: ExtensionContext) => JSON.stringify([ctx.cwd ?? process.cwd(), ctx.sessionManager?.getSessionId?.() ?? ""]);
  return {
    remember(ctx: ExtensionContext, record: DiscoveryRecord): void {
      const scope = key(ctx);
      const choices = sessions.get(scope) ?? new Map<string, DiscoveryRecord>();
      choices.set(recordToken(record), { ...record });
      sessions.set(scope, choices);
    },
    capture(ctx: ExtensionContext, signal: AbortSignal, queries: Iterable<string>): void {
      if (submissions.has(signal)) return;
      const draft = sessions.get(key(ctx));
      const frozen = new Map<string, DiscoveryRecord>();
      for (const query of queries) {
        const record = draft?.get(query);
        if (!record) continue;
        frozen.set(query, record);
        draft!.delete(query);
      }
      if (draft?.size === 0) sessions.delete(key(ctx));
      submissions.set(signal, frozen);
    },
    forSubmission(signal?: AbortSignal): ReadonlyMap<string, DiscoveryRecord> {
      return signal ? submissions.get(signal) ?? new Map() : new Map();
    },
    forContext(ctx: ExtensionContext): ReadonlyMap<string, DiscoveryRecord> {
      return sessions.get(key(ctx)) ?? new Map();
    },
    clear(ctx: ExtensionContext): void {
      sessions.delete(key(ctx));
    },
  };
}
