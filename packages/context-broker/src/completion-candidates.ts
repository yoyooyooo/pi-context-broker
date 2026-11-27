import { isBundledBuiltin } from "./bundled-builtins";
import { recordIdentity, recordToken } from "./discovery-records";
import type { ContentRecord, DiscoveryRecord, SourceConfig } from "./types";
import type { SourceMemberCandidate, SourceMaterializationReceipt } from "./source-materialization-contract";

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
} | {
  origin: "source_member";
  identity: string;
  token: string;
  member: SourceMemberCandidate;
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

/** Unmaterialized members have an exact registered identity, not a physical page
 * or an invented consumable ref. Only input admission may turn them into records. */
export function sourceMemberCompletionCandidates(members: readonly SourceMemberCandidate[],
  source: Extract<SourceConfig, { type: "notion" }>): CompletionCandidate[] {
  return members.filter(member => member.enabled).map(member => ({
    origin: "source_member",
    identity: JSON.stringify([source.id, member.scope, "source_member", member.source_id, member.member_key]),
    token: `${member.alias}@${encodeURIComponent("skill:" + member.expected_skill_id)}@${source.namespace ?? source.id}`,
    member, source: { ...source, library: member.library_id }, scope: member.scope,
  }));
}
/** Receipt preflight failures also retire stale targets. Local choices are
 * owned separately by the completion snapshot and never replaced here. */
export function materializationCompletionCandidates(candidates: readonly CompletionCandidate[],
  source: Extract<SourceConfig, { type: "notion" }>, receipt: SourceMaterializationReceipt): CompletionCandidate[] {
  const records = receipt.status === "ready" || receipt.status === "already_ready"
    ? receipt.records.filter((record): record is ContentRecord & { locator: Extract<ContentRecord["locator"], { type: "shared_skill" }> } => record.locator.type === "shared_skill") : [];
  const affected = new Set([receipt.target.expected_skill_id, ...receipt.affected_skill_ids, ...records.map(record => record.locator.skill_id)]);
  const retained = candidates.filter(candidate => candidate.origin !== "local"
    && (candidate.source.id !== source.id || candidate.scope !== receipt.scope
      || !affected.has(candidate.origin === "source_member" ? candidate.member.expected_skill_id : candidate.record.locator.skill_id)));
  return [...retained, ...notionCompletionCandidates(records, source, receipt.scope, false)];
}

export function candidateMetadata(candidate: CompletionCandidate): Pick<ContentRecord, "kind" | "name" | "alias" | "description"> {
  if (candidate.origin === "source_member") return { kind: candidate.member.record?.kind ?? "skill",
    name: candidate.member.name, alias: candidate.member.alias, description: candidate.member.description };
  return { kind: candidate.record.kind ?? "skill", name: candidate.record.name, alias: candidate.record.alias ?? candidate.record.name, description: candidate.record.description };
}

export function candidateDescription(candidate: CompletionCandidate): string {
  const record = candidateMetadata(candidate);
  const label = candidate.origin !== "local" ? candidate.source.id
    : isBundledBuiltin(candidate.record) ? "bundled builtin" : candidate.record.sourceId ?? "local";
  const description = record.description.replace(/\s+/g, " ").trim();
  const readiness = candidate.origin === "source_member" ? ` · ${candidate.member.source_id} · ${candidate.member.readiness}` : "";
  return `${label}${readiness} · ${description.length > 120 ? description.slice(0, 117).trimEnd() + "..." : description}`;
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

export function sourceMemberQuery(query: string, source: Extract<SourceConfig, { type: "notion" }>): string | undefined {
  const namespace = source.namespace ?? source.id;
  if (query.endsWith("@" + namespace)) return query.slice(0, -namespace.length - 1);
  if (query.startsWith(namespace + "/")) return query.slice(namespace.length + 1);
  return query.includes("@") || query.includes("/") ? undefined : query;
}
export function matchSourceMemberCandidate(query: string, source: Extract<SourceConfig, { type: "notion" }>,
  members: readonly SourceMemberCandidate[], coverage: "complete" | "partial"): SourceMemberCandidate | undefined {
  const selected = sourceMemberQuery(query, source);
  if (!selected) return undefined;
  const stableId = selected.includes("@") ? sourceMemberLookupQuery(query, source) : undefined;
  const matches = selected.includes("@") ? members.filter(member => member.expected_skill_id === stableId)
    : members.filter(member => member.alias === selected || member.name === selected || member.member_key === selected);
  if (matches.length > 1) throw Object.assign(new Error("The Source member selection is ambiguous"), { code: "SOURCE_REFERENCE_AMBIGUOUS" });
  if (!matches.length) return undefined;
  if (coverage !== "complete") throw Object.assign(new Error("The registered Source member directory is incomplete"), { code: "CATALOG_INCOMPLETE" });
  return matches[0];
}

export function sourceMemberLookupQuery(query: string, source: Extract<SourceConfig, { type: "notion" }>): string | undefined {
  const selected = sourceMemberQuery(query, source);
  if (!selected?.includes("@")) return selected;
  try {
    const selector = decodeURIComponent(selected.slice(selected.lastIndexOf("@") + 1));
    return selector.startsWith("skill:") ? selector.slice(6) : undefined;
  }
  catch { return undefined; }
}
