import { SourceError, ReferenceMiss } from "./notion-source";
import { recordIdentity } from "./discovery-records";
import type { SkillRecord } from "./types";

export type PreparationState = "queued" | "running" | "ready" | "missing" | "error" | "cancelled";
export type PreparationDiagnostic = {
  identity: string; sourceId?: string; recordId?: string; state: PreparationState; epoch: number;
  snapshotId?: string; versionId?: string; freshness?: unknown; error?: string;
};
type Consumer = { resolve(record: SkillRecord): void; reject(error: unknown): void; detach(): void };
type Job = { record: SkillRecord; controller: AbortController; consumers: Set<Consumer>; background: boolean; diagnostic: PreparationDiagnostic };

/** Owns concurrent downloads, never session activation or cache freshness policy. */
export function createSourceRuntime(load: (record: SkillRecord, signal: AbortSignal) => Promise<SkillRecord>, concurrency = 2, queueLimit = 32) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(queueLimit) || queueLimit < 1) throw new Error("Invalid source runtime limits");
  const jobs = new Map<string, Job>();
  const retired = new Set<Job>();
  const queue: Job[] = [];
  let epoch = 0;
  let running = 0;
  let disposed = false;
  let planned: Iterator<SkillRecord> | undefined;
  const cancelled = (record: SkillRecord) => new SourceError("SOURCE_CANCELLED", record.sourceId ?? "filesystem");
  function create(record: SkillRecord, background: boolean): Job {
    const job: Job = { record, controller: new AbortController(), consumers: new Set(), background,
      diagnostic: { identity: recordIdentity(record), sourceId: record.sourceId, recordId: record.id, state: "queued", epoch } };
    jobs.set(recordIdentity(record), job);
    return job;
  }
  function cancel(job: Job) {
    job.diagnostic.state = "cancelled";
    job.controller.abort();
    for (const consumer of job.consumers) { consumer.detach(); consumer.reject(cancelled(job.record)); }
    job.consumers.clear();
  }
  function fill() {
    while (planned && queue.length < queueLimit) {
      const next = planned.next();
      if (next.done) { planned = undefined; break; }
      const key = recordIdentity(next.value);
      const previous = jobs.get(key);
      if (previous && previous.diagnostic.epoch === epoch && !previous.controller.signal.aborted && (previous.diagnostic.state === "queued" || previous.diagnostic.state === "running")) { previous.background = true; continue; }
      queue.push(create(next.value, true));
    }
  }
  function pump() {
    if (disposed) return;
    fill();
    while (running < concurrency && queue.length) {
      const job = queue.shift()!;
      if (job.controller.signal.aborted || job.diagnostic.epoch !== epoch) { retired.delete(job); continue; }
      job.diagnostic.state = "running";
      running++;
      // Defer source dispatch so cancellation before the operation starts is effective.
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
      }).finally(() => { retired.delete(job); running--; pump(); });
      fill();
    }
  }
  function invalidate() {
    epoch++;
    planned = undefined;
    queue.length = 0;
    for (const job of jobs.values()) cancel(job);
    for (const job of retired) cancel(job);
    retired.clear();
  }
  return {
    load(record: SkillRecord, signal?: AbortSignal): Promise<SkillRecord> {
      if (disposed || signal?.aborted) return Promise.reject(cancelled(record));
      const key = recordIdentity(record);
      let job = jobs.get(key);
      // Ready bytes never bypass CLI read validation, including max-age=0 and changed auth scopes.
      if (!job || !["queued", "running"].includes(job.diagnostic.state) || job.controller.signal.aborted || job.diagnostic.epoch !== epoch) {
        if (queue.length >= queueLimit) {
          const index = queue.findLastIndex(candidate => candidate.background && !candidate.consumers.size);
          if (index < 0) return Promise.reject(new SourceError("SOURCE_QUEUE_FULL", record.sourceId ?? "filesystem"));
          const deferred = queue.splice(index, 1)[0]!;
          cancel(deferred);
          const remaining = planned;
          planned = (function* () { yield deferred.record; if (remaining) yield* { [Symbol.iterator]: () => remaining }; })();
        }
        job = create(record, false);
        queue.unshift(job);
      }
      const selected = job;
      if (selected.diagnostic.state === "queued") {
        const index = queue.indexOf(selected);
        if (index > 0) { queue.splice(index, 1); queue.unshift(selected); }
      }
      const result = new Promise<SkillRecord>((resolve, reject) => {
        const abort = () => {
          selected.consumers.delete(consumer);
          consumer.detach();
          reject(cancelled(record));
          if (!selected.background && !selected.consumers.size) cancel(selected);
        };
        const consumer: Consumer = { resolve, reject, detach: () => signal?.removeEventListener("abort", abort) };
        selected.consumers.add(consumer);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      pump();
      return result;
    },
    prepare(records: SkillRecord[]) {
      if (disposed) return;
      planned = records.filter(record => record.kind !== "prompt")[Symbol.iterator]();
      pump();
    },
    forgetSources(sourceIds: readonly string[]) {
      const selected = new Set(sourceIds);
      const remaining = planned;
      if (remaining) planned = (function* () {
        for (const record of { [Symbol.iterator]: () => remaining }) if (!record.sourceId || !selected.has(record.sourceId)) yield record;
      })();
      for (const [identity, job] of jobs) {
        if (!job.record.sourceId || !selected.has(job.record.sourceId)) continue;
        jobs.delete(identity);
        if (job.consumers.size) {
          // Existing preparation owns this read. Future selections must start a new one.
          job.background = false;
          retired.add(job);
        } else {
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          cancel(job);
        }
      }
      pump();
    },
    invalidate,
    dispose() { disposed = true; invalidate(); },
    diagnostics(): PreparationDiagnostic[] { return [...jobs.values()].map(job => ({ ...job.diagnostic })); },
  };
}
