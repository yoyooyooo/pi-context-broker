import { recordIdentity } from "./discovery-records";
import type { DiscoveryRecord, ExtensionContext } from "./types";

export type UnavailableReference = { query: string } & (
  | { record: DiscoveryRecord; reason?: "not-found" }
  | { record?: undefined; reason: "catalog-unavailable" }
);
function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function invocation(query: string): string { return query.startsWith("/") ? query : "$" + query; }

export function renderUnavailableReferences(selections: readonly UnavailableReference[]): string {
  if (!selections.length) return "";
  return [
    "<context-broker-unavailable>",
    "The selected references below were not loaded. Do not claim their instructions were read or followed. Other successfully loaded content and the user's original message remain available.",
    ...selections.map(({ query, reason }) => {
      const message = reason === "catalog-unavailable" ? "Unavailable in the current catalog; not loaded." : "Not found; not loaded.";
      return `<reference invocation="${xml(invocation(query))}" reason="${reason ?? "not-found"}">${message}</reference>`;
    }),
    "</context-broker-unavailable>",
  ].join("\n");
}

export function unavailableReferenceDetails(selections: readonly UnavailableReference[]) {
  return selections.map(({ record, query, reason }) => ({
    ...(record ? { identity: recordIdentity(record), ref: record.ref ?? record.path } : {}),
    query,
    state: "not-loaded",
    reason: reason ?? "not-found",
  }));
}

export function notifyUnavailableReferences(ctx: ExtensionContext, selections: readonly UnavailableReference[]): void {
  if (!selections.length) return;
  try {
    ctx.ui?.notify?.("context-broker: not loaded: " + selections.map(({ query }) => invocation(query)).join(", ") + ". Selected content is unavailable; refresh the catalog to choose again.", "warning");
  } catch { /* UI notifications must not prevent the original submission. */ }
}
