import type { SkillRecord, SourceConfig } from "./types";

/** A zero or incomplete budget never schedules speculative body work. */
export type PrefetchBudget = {
  maxNodes: number; maxBytes: number; maxDepth: number; maxTimeMs: number; rateShare: number;
};
export type PrefetchPlan = {
  source: Extract<SourceConfig, { type: "notion" }>;
  records: readonly SkillRecord[];
  budget: PrefetchBudget;
};
export type PrefetchOutcome = {
  preparedNodes: number; instructionBytes: number; contextBytes: number;
  records: readonly { id: string; scope: string; snapshotId: string; bodySha256: string; bytes: number }[];
};

export function prefetchBudget(value: boolean | PrefetchBudget | undefined): PrefetchBudget {
  return value && typeof value === "object" ? value : { maxNodes: 0, maxBytes: 0, maxDepth: 0, maxTimeMs: 0, rateShare: 0 };
}
export function enabledPrefetchBudget(budget: PrefetchBudget): boolean {
  return budget.maxNodes > 0 && budget.maxBytes > 0 && budget.maxTimeMs > 0 && budget.rateShare > 0;
}
export function selectPrefetchPlans(records: readonly SkillRecord[], sources: readonly SourceConfig[] = []): PrefetchPlan[] {
  const seen = new Set<string>(), plans: PrefetchPlan[] = [];
  for (const source of sources) {
    if (source.type !== "notion" || source.enabled === false) continue;
    const budget = prefetchBudget(source.prefetch);
    if (!enabledPrefetchBudget(budget)) continue;
    const selected = records.filter(record => record.sourceId === source.id && record.source === "notion" &&
      record.defaultDiscovery === true && record.enabled !== false && record.kind !== "prompt" && record.id && record.sourceScope)
      .filter(record => { const key = JSON.stringify([record.sourceScope, record.id]); if (seen.has(key)) return false; seen.add(key); return true; })
      .slice(0, budget.maxNodes);
    if (selected.length) plans.push({ source, records: selected, budget });
  }
  return plans;
}
