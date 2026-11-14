import { recordIdentity } from "./discovery-records";
import type { SkillRecord } from "./types";

export type CurrentEvidence = {
  readonly origin: "remote" | "cache";
  readonly validatedAt: number;
  readonly validUntil: number;
};
export type CurrentAvailability = "available" | "disabled" | "denied";
export type ObservationTicket = {
  readonly generation: number;
  readonly order: number;
  readonly startedAt: number;
  readonly signal: AbortSignal | undefined;
};
type Observation = {
  readonly state: CurrentAvailability;
  readonly code: "CONTENT_DISABLED" | "ACCESS_DENIED" | "AUTH_REQUIRED" | undefined;
  readonly evidence: CurrentEvidence;
  readonly order: number;
  readonly live: boolean;
};

/** Interpret proof already supplied by the CLI; reading cached bytes is not a new validation. */
export function currentEvidence(freshness: unknown, source: unknown): CurrentEvidence | undefined {
  if (!freshness || typeof freshness !== "object" || !("policy" in freshness)
    || !["default", "max_age", "refresh"].includes(String(freshness.policy))
    || !("validated_at" in freshness) || typeof freshness.validated_at !== "string"
    || !("max_age_ms" in freshness) || typeof freshness.max_age_ms !== "number"
    || !("stale" in freshness) || typeof freshness.stale !== "boolean"
    || freshness.stale && source !== "notion"
    || source !== "notion" && source !== "local_cache") return undefined;
  const validatedAt = Date.parse(freshness.validated_at), duration = freshness.max_age_ms;
  if (!Number.isFinite(validatedAt) || !Number.isFinite(duration) || duration < 0
    || !Number.isFinite(validatedAt + duration)) return undefined;
  return { origin: source === "notion" ? "remote" : "cache", validatedAt, validUntil: validatedAt + duration };
}

/** One process-local owner for mutable qualification; content snapshots remain immutable. */
export function createConsumerObservations(generation: () => number, now = Date.now) {
  const values = new Map<string, Observation>();
  let order = 0;
  const current = (ticket: ObservationTicket) => ticket.generation === generation() && !ticket.signal?.aborted;
  const accept = (key: string, ticket: ObservationTicket, next: Observation) => {
    if (!current(ticket)) return false;
    const previous = values.get(key);
    if (previous && (previous.live && next.live && ticket.order < previous.order
      || next.evidence.validatedAt < previous.evidence.validatedAt
      || !next.live && next.evidence.validatedAt <= previous.evidence.validatedAt)) return false;
    values.set(key, next);
    return true;
  };
  return {
    begin(signal?: AbortSignal): ObservationTicket {
      return { generation: generation(), order: ++order, startedAt: now(), signal };
    },
    observe(record: SkillRecord, ticket: ObservationTicket): boolean {
      const evidence = record.currentObservation;
      if (record.source !== "notion" || !record.id || !record.sourceScope || !evidence
        || evidence.validatedAt > now() || evidence.origin === "cache" && evidence.validUntil <= now()) return false;
      return accept(recordIdentity(record), ticket, { state: record.enabled === false ? "disabled" : "available",
        code: record.enabled === false ? "CONTENT_DISABLED" : undefined, evidence, order: ticket.order,
        live: evidence.origin === "remote" && evidence.validatedAt >= ticket.startedAt });
    },
    deny(record: SkillRecord, ticket: ObservationTicket, code: "CONTENT_DISABLED" | "ACCESS_DENIED" | "AUTH_REQUIRED"): boolean {
      if (record.source !== "notion" || !record.id || !record.sourceScope) return false;
      return accept(recordIdentity(record), ticket, { state: code === "CONTENT_DISABLED" ? "disabled" : "denied", code,
        evidence: { origin: "remote", validatedAt: ticket.startedAt, validUntil: ticket.startedAt }, order: ticket.order, live: true });
    },
    state(record: SkillRecord): CurrentAvailability {
      return values.get(recordIdentity(record))?.state ?? (record.enabled === false ? "disabled" : "available");
    },
    denial(record: SkillRecord): "CONTENT_DISABLED" | "ACCESS_DENIED" | "AUTH_REQUIRED" | undefined {
      return values.get(recordIdentity(record))?.code ?? (record.enabled === false ? "CONTENT_DISABLED" : undefined);
    },
    canPublish(record: SkillRecord, ticket: ObservationTicket): boolean {
      const latest = values.get(recordIdentity(record));
      return current(ticket) && (!latest?.live || latest.order <= ticket.order);
    },
    current,
  };
}
