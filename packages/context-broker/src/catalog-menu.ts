import type { NotionListObservation } from "./types";

export const notionCatalogRetryGapMs = 5_000;

export function notionListExpired(observation: NotionListObservation | undefined, now: number): boolean {
  if (!observation) return true;
  if (observation.policy === "offline" || observation.policy === "pinned") return false;
  if (observation.stale) return true;
  if (observation.validatedAt === undefined || observation.ageMs === undefined || observation.maxAgeMs === undefined) return true;
  const validated = Date.parse(observation.validatedAt);
  if (!Number.isFinite(validated)) return true;
  return !Number.isFinite(observation.ageMs) || observation.ageMs < 0 || now < validated || Math.max(observation.ageMs, now - validated) >= observation.maxAgeMs;
}

export function notionCatalogAction(input: {
  offline: boolean;
  sourceIds: string[];
  observations: NotionListObservation[];
  failedSourceIds: string[];
  now: number;
  retryAt?: number;
}): "use" | "refresh" | "wait" {
  if (input.offline || input.sourceIds.length === 0) return "use";
  const bySource = new Map(input.observations.map((item) => [item.sourceId, item]));
  const expired = input.sourceIds.some((id) => input.failedSourceIds.includes(id) || notionListExpired(bySource.get(id), input.now));
  if (!expired) return "use";
  if (input.retryAt !== undefined && input.now < input.retryAt) return "wait";
  return "refresh";
}
