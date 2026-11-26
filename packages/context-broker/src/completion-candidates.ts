import { isBundledBuiltin } from "./bundled-builtins";
import { recordIdentity, recordToken } from "./discovery-records";
import type { ContentRecord, DiscoveryRecord, SourceConfig } from "./types";

export type CompletionCandidate = {
  origin: "local";
  identity: string;
  token: string;
  record: DiscoveryRecord;
} | {
  origin: "notion";
  identity: string;
  token: string;
  record: ContentRecord & { locator: Extract<ContentRecord["locator"], { type: "shared_skill" }> };
  source: Extract<SourceConfig, { type: "notion" }>;
  scope: string;
};

/** A menu target contains metadata and an exact binding, never a fabricated path. */
export function localCompletionCandidate(record: DiscoveryRecord): CompletionCandidate {
  return { origin: "local", identity: recordIdentity(record), token: recordToken(record), record: { ...record } };
}

export function notionCompletionCandidates(
  records: Array<ContentRecord & { locator: Extract<ContentRecord["locator"], { type: "shared_skill" }> }>,
  source: Extract<SourceConfig, { type: "notion" }>, scope: string, complete: boolean,
): CompletionCandidate[] {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.alias, (counts.get(record.alias) ?? 0) + 1);
  return records.filter(record => record.enabled !== false).map(record => {
    const alias = record.alias + (!complete || counts.get(record.alias)! > 1 ? `@${record.locator.page_id.replaceAll("-", "")}` : "");
    return { origin: "notion", identity: JSON.stringify([source.id, scope, record.kind, record.locator.type, record.id]),
      token: `${alias}@${source.namespace ?? source.id}`, record: { ...record, locator: { ...record.locator } },
      source: { ...source, library: record.locator.library_id }, scope };
  });
}

export function candidateDescription(candidate: CompletionCandidate): string {
  const record = candidate.record;
  const label = candidate.origin === "notion" ? candidate.source.id
    : isBundledBuiltin(candidate.record) ? "bundled builtin" : candidate.record.sourceId ?? "local";
  const description = record.description.replace(/\s+/g, " ").trim();
  return `${label} · ${description.length > 120 ? description.slice(0, 117).trimEnd() + "..." : description}`;
}

export type CompletionSnapshot = { candidates: readonly CompletionCandidate[]; revision: number; notice?: string };
type Ticket = { owner: object; order: number; phase: "cache" | "refresh" };

/** One in-memory publication owner for one session/branch/Library selection. */
export function createCompletionSnapshot(notify: () => void) {
  const owner = {};
  let retired = false, order = 0, publishedOrder = 0, refreshed = false, revision = 0;
  let local: readonly CompletionCandidate[] = [], remote: readonly CompletionCandidate[] = [];
  let snapshot: CompletionSnapshot = { candidates: [], revision };
  const publish = (notice?: string) => {
    const identities = new Set<string>();
    snapshot = { candidates: [...local, ...remote].filter(candidate => {
      if (identities.has(candidate.identity)) return false;
      identities.add(candidate.identity); return true;
    }), revision: ++revision, ...(notice ? { notice } : {}) };
    notify();
  };
  return {
    read: () => snapshot,
    begin: (phase: Ticket["phase"]): Ticket => ({ owner, order: ++order, phase }),
    local(candidates: readonly CompletionCandidate[]) {
      if (retired) return;
      local = candidates; publish(snapshot.notice);
    },
    accept(ticket: Ticket, candidates: readonly CompletionCandidate[], notice?: string): boolean {
      if (retired || ticket.owner !== owner || ticket.order < publishedOrder || ticket.phase === "cache" && refreshed) return false;
      publishedOrder = ticket.order;
      refreshed ||= ticket.phase === "refresh";
      remote = candidates; publish(notice); return true;
    },
    warn(notice: string) { if (!retired && notice !== snapshot.notice) publish(notice); },
    retire() { retired = true; },
  };
}
