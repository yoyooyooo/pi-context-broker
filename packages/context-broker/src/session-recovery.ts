import { createHash } from "node:crypto";
import { recordIdentity } from "./discovery-records";
import { SourceError, sourceFailureMessage } from "./notion-source";
import { activeSelection, activeSources, assertRestoredSource, type ActiveSource } from "./session-active";
import { selectedClosure, type SelectionMode, type SessionSelection } from "./session-graph";
import { projectSelectedSourceMessages, sourceContentIdentity, sourceDeliveryLoaded } from "./session-source-snapshot";
import { checkPreparationSignal } from "./skill-preparation";
import type { PreparedHostGraph } from "./prepare-protocol";
import { DEFAULT_RESOURCE_READ_BUDGET } from "./resource-read-types";
import type { AgentMessage, ExtensionContext, SkillRecord } from "./types";

type Pending = readonly { graphs: readonly PreparedHostGraph[]; mode: SelectionMode }[];
type Message = Omit<AgentMessage, "role" | "timestamp">;
type Root = { identity: string; name: string; ref: string; closure: Set<string> };
type Group = { roots: Root[]; identities: Set<string> };
type Failure = { code: string; cause: unknown };
export type ActiveContextRestoration = { messages: AgentMessage[]; restored: Message[]; notices: Message[] };
export const RECOVERY_NOTICE = "context-broker-recovery";
// A failed fixed read must not become a blocking acquisition on every tool turn
// or every subsequent user message. Successful delivery clears this backoff.
export const FIXED_RESTORE_RETRY_MS = 30_000;
const recoverableLocalFailures = new Set(["ENOENT", "EACCES", "EIO", "ENOSPC", "SOURCE_IDENTITY_MISMATCH"]);

function restorationFailure(error: unknown): Failure {
  // A source acquisition can be unavailable without making the user's entire
  // operation invalid. No returned bytes are trusted on this failure path.
  if (error instanceof SourceError && error.code !== "SOURCE_CANCELLED") return { code: error.code, cause: error };
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && recoverableLocalFailures.has(error.code))
    return { code: error.code, cause: error };
  // Cancellation, malformed session receipts and payload/epoch guard failures
  // are not an unavailable Skill and must retain their existing fail-closed path.
  throw error;
}

function waitForRecovery<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => { checkPreparationSignal(signal); return read(); }).then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function contextPlan(ctx: ExtensionContext, pending: Pending) {
  const active = activeSources(ctx), selection = activeSelection(ctx, pending), sources = new Map(active.sources);
  for (const transition of pending) for (const graph of transition.graphs) {
    if (graph.purpose !== "use") continue;
    for (const record of graph.records) {
      if (typeof record.body !== "string" || !record.snapshotId) continue;
      const contentIdentity = sourceContentIdentity(record);
      sources.set(contentIdentity, { identity: recordIdentity(record), contentIdentity, snapshotId: record.snapshotId,
        bodySha256: createHash("sha256").update(record.body).digest("hex"), bytes: Buffer.byteLength(record.body), record });
    }
  }
  for (const [identity, source] of sources) {
    if (source.record.source !== "notion") continue;
    const binding = source.record.sourceScope && selection.scopes.get(source.record.sourceScope)?.bindings.get(source.record.id!);
    if (!binding || binding.snapshot_id !== source.snapshotId || binding.body_sha256 !== source.bodySha256) sources.delete(identity);
  }
  const roots: Root[] = [];
  for (const scope of selection.scopes.values()) for (const id of scope.roots) {
    const binding = scope.bindings.get(id);
    if (!binding) continue;
    roots.push({ identity: JSON.stringify([scope.scope, id]), name: binding.record.name, ref: binding.ref,
      closure: new Set([...selectedClosure(scope, [id])].map(member => JSON.stringify([scope.scope, member]))) });
  }
  for (const source of sources.values()) if (source.record.source !== "notion")
    roots.push({ identity: source.contentIdentity, name: source.record.name, ref: source.record.path, closure: new Set([source.contentIdentity]) });
  return { roots, sources, selection };
}

/** Complete means exact bytes in this context, never historical activation. */
export function activeContextClosures(ctx: ExtensionContext, messages: AgentMessage[], pending: Pending = []) {
  const { roots, sources } = contextPlan(ctx, pending);
  return roots.map(root => ({ ref: root.ref, name: root.name, missing: [...root.closure].filter(identity => {
    const source = sources.get(identity);
    return !source || !sourceDeliveryLoaded(messages, source);
  }) }));
}

/** A later context hook may not silently turn a complete requested closure into
 * a partial one. Already withheld roots stay degraded without blocking chat. */
export function assertActiveContextDelivery(ctx: ExtensionContext, prepared: AgentMessage[], final: AgentMessage[], pending: Pending = []): void {
  const { roots, sources } = contextPlan(ctx, pending);
  const present = (messages: AgentMessage[], identity: string) => {
    const source = sources.get(identity);
    return source !== undefined && sourceDeliveryLoaded(messages, source);
  };
  for (const root of roots) {
    const expected = [...root.closure].every(identity => present(prepared, identity));
    const complete = [...root.closure].every(identity => present(final, identity));
    if ((expected || present(final, root.identity)) && !complete)
      throw Object.assign(new Error("The final context lost a mandatory Skill instruction closure"), { code: "SOURCE_CONTEXT_CLOSURE_INCOMPLETE" });
  }
}

/** Recover connected fixed closures independently. Nothing here commits a new
 * selection, clears a pin, or confirms delivery. */
export function createActiveSourceRestorer(options: {
  assertAvailable(record: SkillRecord): void;
  load(sources: readonly ActiveSource[], missing: readonly ActiveSource[], ctx: ExtensionContext, signal: AbortSignal): Promise<SkillRecord[]>;
  render(records: readonly SkillRecord[], ctx: ExtensionContext, selection: SessionSelection): Message | undefined;
  now?: () => number;
  timeout?: (milliseconds: number) => AbortSignal;
}) {
  const now = options.now ?? Date.now;
  const deferred = new Map<string, { failure: Failure; retryAt: number }>();
  return async (messages: AgentMessage[], ctx: ExtensionContext, signal: AbortSignal, pending: Pending): Promise<ActiveContextRestoration> => {
    checkPreparationSignal(signal);
    // One foreground-read budget for the entire context restoration. Source
    // requestTimeoutMs remains a per-network-attempt limit, not a new budget
    // for every connected component. Host cancellation has precedence below.
    const deadline = (options.timeout ?? (milliseconds => AbortSignal.timeout(milliseconds)))(DEFAULT_RESOURCE_READ_BUDGET.timeBudgetMs);
    const recoverySignal = AbortSignal.any([signal, deadline]);
    const exhausted = (cause?: unknown): Failure => ({ code: "SOURCE_RECOVERY_TIME_BUDGET", cause });
    const { roots, sources, selection } = contextPlan(ctx, pending), groups: Group[] = [];
    for (const root of roots) {
      const joined = groups.filter(group => [...root.closure].some(identity => group.identities.has(identity)));
      const group: Group = { roots: [root, ...joined.flatMap(value => value.roots)],
        identities: new Set([...root.closure, ...joined.flatMap(value => [...value.identities])]) };
      for (const previous of joined) groups.splice(groups.indexOf(previous), 1);
      groups.push(group);
    }
    const key = (group: Group) => JSON.stringify([ctx.sessionManager?.getSessionId?.(), group.roots.map(root => root.identity).sort(),
      [...group.identities].sort().map(identity => { const source = sources.get(identity); return [identity, source?.snapshotId, source?.bodySha256]; })]);
    const keys = new Set(groups.map(key));
    for (const previous of deferred.keys()) if (!keys.has(previous)) deferred.delete(previous);
    const failures = new Map<string, Failure>(), restored = new Map<string, SkillRecord>();
    const unavailable = (source: ActiveSource): Failure | undefined => {
      try { options.assertAvailable(source.record); return undefined; }
      catch (error) { return restorationFailure(error); }
    };
    for (const group of groups) {
      checkPreparationSignal(signal);
      const members = [...group.identities].flatMap(identity => { const source = sources.get(identity); return source ? [source] : []; });
      const missing = members.filter(source => !sourceDeliveryLoaded(messages, source));
      const denied = members.map(unavailable).find(value => value !== undefined);
      const groupKey = key(group);
      if (denied) { failures.set(groupKey, denied); continue; }
      if (!missing.length) { deferred.delete(groupKey); continue; }
      const prior = deferred.get(groupKey);
      if (prior && prior.retryAt > now() && prior.failure.code !== "ACCESS_DENIED" && prior.failure.code !== "AUTH_REQUIRED") {
        failures.set(groupKey, prior.failure); continue;
      }
      if (deadline.aborted) {
        const failure = exhausted(deadline.reason);
        failures.set(groupKey, failure); deferred.set(groupKey, { failure, retryAt: now() + FIXED_RESTORE_RETRY_MS });
        continue;
      }
      try {
        const loaded = await waitForRecovery(() => options.load(members, missing, ctx, recoverySignal), recoverySignal);
        checkPreparationSignal(signal);
        for (const expected of missing) {
          const record = loaded.find(value => sourceContentIdentity(value) === expected.contentIdentity);
          if (!record) throw Object.assign(new Error("Fixed restoration omitted a selected node"), { code: "SOURCE_IDENTITY_MISMATCH" });
          restored.set(expected.contentIdentity, assertRestoredSource(expected, record));
        }
        deferred.delete(groupKey);
      } catch (error) {
        checkPreparationSignal(signal);
        const failure = deadline.aborted ? exhausted(error) : restorationFailure(error);
        failures.set(groupKey, failure); deferred.set(groupKey, { failure, retryAt: now() + FIXED_RESTORE_RETRY_MS });
      }
    }
    checkPreparationSignal(signal);
    const candidate = options.render([...restored.values()], ctx, selection);
    const completeMessages = candidate ? [...messages, { ...candidate, role: "custom" }] : messages;
    const available = new Set<string>();
    const incomplete: Array<{ root: Root; missing: string[]; code: string }> = [];
    for (const group of groups) for (const root of group.roots) {
      const missing = [...root.closure].filter(identity => {
        const source = sources.get(identity);
        return !source || unavailable(source) !== undefined || !sourceDeliveryLoaded(completeMessages, source);
      });
      if (missing.length) incomplete.push({ root, missing, code: failures.get(key(group))?.code ?? "SOURCE_CONTEXT_INCOMPLETE" });
      else for (const identity of root.closure) available.add(identity);
    }
    const withheld = new Set(incomplete.flatMap(value => [...value.root.closure]).filter(identity => !available.has(identity)));
    const projected = projectSelectedSourceMessages(messages, { scopes: new Map() },
      (scope, id) => withheld.has(JSON.stringify([scope, id])) ? "incomplete" : undefined);
    const accepted = options.render([...restored].filter(([identity]) => !withheld.has(identity)).map(([, record]) => record), ctx, selection);
    const recovery = incomplete.map(({ root, missing, code }) => ({ name: root.name, ref: root.ref, code, missing,
      reason: code === "SOURCE_CONTEXT_INCOMPLETE" ? "The selected mandatory instructions are not present in this request." : sourceFailureMessage(code) }));
    const notices: Message[] = recovery.length ? [{ customType: RECOVERY_NOTICE, display: false,
      content: "<skill-recovery>\nSome selected Skill closures are unavailable for this request. Do not execute partial Skill instructions. "
        + "Continue ordinary conversation and independent capabilities. The fixed selections are unchanged. "
        + "The user may release an unused root, or explicitly select current content to update.\n" + JSON.stringify(recovery) + "\n</skill-recovery>",
      details: { version: 1, phase: "fixed_restore", recovery } }] : [];
    return { messages: projected, restored: accepted ? [accepted] : [], notices };
  };
}
