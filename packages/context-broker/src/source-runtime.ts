import { SourceError, ReferenceMiss } from "./notion-source";
import { recordIdentity } from "./discovery-records";
import { enabledPrefetchBudget, type PrefetchOutcome, type PrefetchPlan } from "./prefetch-policy";
import type { SkillRecord } from "./types";

export type PreparationState = "queued" | "running" | "ready" | "prepared" | "missing" | "error" | "cancelled" | "deferred";
export type PreparationDiagnostic = {
  identity: string; sourceId?: string; recordId?: string; state: PreparationState; epoch: number;
  purpose: "foreground" | "prefetch"; loaded: false;
  snapshotId?: string; versionId?: string; freshness?: unknown; error?: string; reason?: string;
  budget?: PrefetchPlan["budget"]; preparedNodes?: number; instructionBytes?: number; contextBytes?: number; elapsedMs?: number;
  records?: PrefetchOutcome["records"];
};
type Consumer = { resolve(record: SkillRecord): void; reject(error: unknown): void; detach(): void };
type Job = { record: SkillRecord; controller: AbortController; consumers: Set<Consumer>; diagnostic: PreparationDiagnostic };
type WarmJob = { plan: PrefetchPlan; controller: AbortController; diagnostic: PreparationDiagnostic; timer?: NodeJS.Timeout };

/** Owns source process lifetimes. Graphs, freshness and HTTP scheduling stay in the CLI. */
export function createSourceRuntime(
  load: (record: SkillRecord, signal: AbortSignal) => Promise<SkillRecord>,
  concurrency = 2,
  queueLimit = 32,
  warm?: (plan: PrefetchPlan, signal: AbortSignal) => Promise<PrefetchOutcome>,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(queueLimit) || queueLimit < 1) throw new Error("Invalid source runtime limits");
  const jobs = new Map<string, Job>(), retired = new Set<Job>(), queue: Job[] = [];
  const warming = new Map<string, WarmJob>(), warmQueue: WarmJob[] = [], attemptedWarm = new Set<string>();
  let epoch = 0, running = 0, foregroundOwners = 0, disposed = false, activeWarm: WarmJob | undefined;
  const cancelled = (record: SkillRecord) => new SourceError("SOURCE_CANCELLED", record.sourceId ?? "filesystem");
  function cancel(job: Job) {
    job.diagnostic.state = "cancelled";
    job.controller.abort();
    for (const consumer of job.consumers) { consumer.detach(); consumer.reject(cancelled(job.record)); }
    job.consumers.clear();
  }
  function pausePrefetch(reason: string, sources?: ReadonlySet<string>) {
    for (const job of warming.values()) {
      if (sources && !sources.has(job.plan.source.id) || !["queued", "running"].includes(job.diagnostic.state)) continue;
      job.diagnostic.state = "cancelled"; job.diagnostic.reason = reason;
      clearTimeout(job.timer); job.controller.abort();
    }
    for (let index = warmQueue.length - 1; index >= 0; index--) if (warmQueue[index]!.controller.signal.aborted) warmQueue.splice(index, 1);
  }
  function pumpWarm() {
    if (!warm || disposed || foregroundOwners > 0 || running > 0 || queue.length > 0 || activeWarm) return;
    const job = warmQueue.shift();
    if (!job) return;
    if (job.controller.signal.aborted || job.diagnostic.epoch !== epoch) { pumpWarm(); return; }
    activeWarm = job;
    job.diagnostic.state = "running";
    const started = Date.now();
    job.timer = setTimeout(() => {
      if (job.diagnostic.state !== "running") return;
      job.diagnostic.state = "cancelled"; job.diagnostic.reason = "time_budget";
      job.controller.abort();
    }, job.plan.budget.maxTimeMs);
    void Promise.resolve().then(() => {
      if (disposed || job.controller.signal.aborted || job.diagnostic.epoch !== epoch) throw new SourceError("SOURCE_CANCELLED", job.plan.source.id);
      return warm(job.plan, job.controller.signal);
    }).then(result => {
      if (disposed || job.controller.signal.aborted || job.diagnostic.epoch !== epoch) return;
      if (result.preparedNodes > job.plan.budget.maxNodes || result.contextBytes > job.plan.budget.maxBytes || result.instructionBytes > job.plan.budget.maxBytes)
        throw new SourceError("SOURCE_PREFETCH_BUDGET", job.plan.source.id);
      Object.assign(job.diagnostic, { state: "prepared", ...result });
    }).catch(error => {
      if (job.controller.signal.aborted || job.diagnostic.epoch !== epoch) return;
      const code = error instanceof SourceError ? error.code : "SOURCE_STORAGE_ERROR";
      const pressure = ["RATE_LIMITED", "NOTION_PREFETCH_DEFERRED", "PREPARE_TIME_BUDGET"].includes(code);
      job.diagnostic.state = pressure ? "deferred" : "error"; job.diagnostic.error = code;
      if (pressure) pausePrefetch("service_pressure");
    }).finally(() => {
      clearTimeout(job.timer);
      job.diagnostic.elapsedMs = Date.now() - started;
      if (activeWarm === job) activeWarm = undefined;
      pumpWarm();
    });
  }
  function pump() {
    if (disposed) return;
    while (running < concurrency && queue.length) {
      const job = queue.shift()!;
      if (job.controller.signal.aborted || job.diagnostic.epoch !== epoch) { retired.delete(job); continue; }
      job.diagnostic.state = "running"; running++;
      void Promise.resolve().then(() => {
        if (job.controller.signal.aborted || job.diagnostic.epoch !== epoch || disposed) throw cancelled(job.record);
        return load(job.record, job.controller.signal);
      }).then(result => {
        if (job.controller.signal.aborted || job.diagnostic.epoch !== epoch || disposed) throw cancelled(job.record);
        Object.assign(job.diagnostic, { state: "ready", snapshotId: result.snapshotId, versionId: result.versionId, freshness: result.freshness });
        for (const consumer of job.consumers) { consumer.detach(); consumer.resolve(result); }
        job.consumers.clear();
      }).catch(error => {
        if (job.diagnostic.state !== "cancelled") {
          job.diagnostic.state = job.controller.signal.aborted ? "cancelled" : error instanceof ReferenceMiss ? "missing" : "error";
          job.diagnostic.error = error instanceof ReferenceMiss ? undefined : error instanceof SourceError ? error.code : "SOURCE_STORAGE_ERROR";
        }
        for (const consumer of job.consumers) { consumer.detach(); consumer.reject(error); }
        job.consumers.clear();
      }).finally(() => { retired.delete(job); running--; pump(); pumpWarm(); });
    }
  }
  function loadForeground(record: SkillRecord, signal?: AbortSignal): Promise<SkillRecord> {
    if (disposed || signal?.aborted) return Promise.reject(cancelled(record));
    const key = recordIdentity(record);
    let job = jobs.get(key);
    // Ready bytes never bypass current authorization or CLI freshness validation.
    if (!job || !["queued", "running"].includes(job.diagnostic.state) || job.controller.signal.aborted || job.diagnostic.epoch !== epoch) {
      if (queue.length >= queueLimit) return Promise.reject(new SourceError("SOURCE_QUEUE_FULL", record.sourceId ?? "filesystem"));
      job = { record, controller: new AbortController(), consumers: new Set(),
        diagnostic: { identity: key, sourceId: record.sourceId, recordId: record.id, state: "queued", epoch, purpose: "foreground", loaded: false } };
      jobs.set(key, job); queue.push(job);
    }
    const selected = job;
    const result = new Promise<SkillRecord>((resolve, reject) => {
      const abort = () => {
        selected.consumers.delete(consumer); consumer.detach(); reject(cancelled(record));
        if (!selected.consumers.size) cancel(selected);
      };
      const consumer: Consumer = { resolve, reject, detach: () => signal?.removeEventListener("abort", abort) };
      selected.consumers.add(consumer);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    pump();
    return result;
  }
  async function foreground<A>(operation: () => Promise<A>): Promise<A> {
    foregroundOwners++; pausePrefetch("foreground");
    try { return await operation(); }
    finally { foregroundOwners--; pumpWarm(); }
  }
  function invalidate() {
    epoch++;
    pausePrefetch("session_or_refresh");
    warmQueue.length = 0; attemptedWarm.clear(); queue.length = 0;
    for (const job of jobs.values()) cancel(job);
    for (const job of retired) cancel(job);
    retired.clear();
  }
  return {
    load: (record: SkillRecord, signal?: AbortSignal) => foreground(() => loadForeground(record, signal)),
    foreground,
    pausePrefetch,
    prefetch(plans: readonly PrefetchPlan[]) {
      if (disposed || !warm || foregroundOwners > 0) return;
      for (const plan of plans) {
        if (!enabledPrefetchBudget(plan.budget) || !plan.records.length || plan.records.length > plan.budget.maxNodes) continue;
        const identities = plan.records.map(recordIdentity);
        if (identities.some(identity => attemptedWarm.has(identity))) continue;
        if (warmQueue.length >= queueLimit) break;
        for (const identity of identities) attemptedWarm.add(identity);
        const key = JSON.stringify([epoch, plan.source.id, identities]);
        const job: WarmJob = { plan, controller: new AbortController(),
          diagnostic: { identity: key, sourceId: plan.source.id, state: "queued", epoch, purpose: "prefetch", loaded: false, budget: { ...plan.budget } } };
        warming.set(key, job); warmQueue.push(job);
      }
      pumpWarm();
    },
    forgetSources(sourceIds: readonly string[]) {
      const selected = new Set(sourceIds);
      pausePrefetch("source_changed", selected);
      for (const [identity, job] of jobs) {
        if (!job.record.sourceId || !selected.has(job.record.sourceId)) continue;
        jobs.delete(identity);
        if (job.consumers.size) retired.add(job);
        else {
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          cancel(job);
        }
      }
      pump(); pumpWarm();
    },
    invalidate,
    dispose() { disposed = true; invalidate(); },
    diagnostics(): PreparationDiagnostic[] { return [...jobs.values(), ...warming.values()].map(job => ({ ...job.diagnostic })); },
  };
}
