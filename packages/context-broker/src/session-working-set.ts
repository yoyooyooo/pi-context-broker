import { randomUUID } from "node:crypto";
import { activeSelection, activeSources } from "./session-active";
import { activeContextClosures } from "./session-recovery";
import { parseNativeReference } from "./native-reference";
import type { PreparedHostGraph } from "./prepare-protocol";
import type { ConsumptionEffects } from "./consumption-effects";
import { decodeRootRelease, selectedClosure, SESSION_RELEASE_ENTRY, type ReleasedRoot, type SelectionMode } from "./session-graph";
import { projectSelectedSourceMessages, sourceDeliveryLoaded } from "./session-source-snapshot";
import type { AgentMessage, ExtensionAPI, ExtensionContext } from "./types";

export const SESSION_WORKING_SET_BUDGET_ENTRY = "context-broker-working-set-budget";
type PendingGraphs = readonly { graphs: readonly PreparedHostGraph[]; mode: SelectionMode }[];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

export function workingSetBudget(ctx: ExtensionContext): number | null {
  let bytes: number | null = null;
  for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
    if (entry.type !== "custom" || entry.customType !== SESSION_WORKING_SET_BUDGET_ENTRY) continue;
    const value = entry.data;
    if (!object(value) || value.version !== 1 || value.max_instruction_bytes !== null
      && (!Number.isSafeInteger(value.max_instruction_bytes) || Number(value.max_instruction_bytes) <= 0))
      throw failure("SOURCE_WORKING_SET_BUDGET_INVALID", "Invalid session working-set budget");
    bytes = value.max_instruction_bytes === null ? null : Number(value.max_instruction_bytes);
  }
  return bytes;
}

export function exportWorkingSet(ctx: ExtensionContext, messages: AgentMessage[], pending: PendingGraphs = []) {
  const active = activeSources(ctx), selection = activeSelection(ctx, pending);
  const projected = projectSelectedSourceMessages(messages, selection);
  const measured = new Map([...active.sources].map(([identity, source]) => [identity, source.bytes]));
  for (const transition of pending) for (const graph of transition.graphs) for (const record of graph.records)
    if (typeof record.body === "string") measured.set(JSON.stringify([record.sourceScope, record.id]), Buffer.byteLength(record.body));
  const nodes = [...selection.scopes.values()].flatMap(scope => [...scope.bindings.values()].map(binding => {
    const identity = JSON.stringify([scope.scope, binding.record.id]), confirmed = active.sources.get(identity);
    const roots = [...scope.roots].filter(root => selectedClosure(scope, [root]).has(binding.record.id));
    return { scope: scope.scope, id: binding.record.id, ref: binding.ref, name: binding.record.name,
      snapshot_id: binding.snapshot_id, body_sha256: binding.body_sha256,
      root: scope.roots.has(binding.record.id), required_by: roots.filter(root => root !== binding.record.id),
      instruction_bytes: measured.get(identity) ?? null,
      confirmed: confirmed?.snapshotId === binding.snapshot_id && confirmed.bodySha256 === binding.body_sha256,
      visible: !!confirmed && sourceDeliveryLoaded(projected, confirmed) };
  }));
  const missing = nodes.some(node => node.instruction_bytes === null);
  const instruction_bytes = missing ? null : nodes.reduce((sum, node) => sum + (node.instruction_bytes ?? 0), 0);
  const limit = workingSetBudget(ctx);
  const release_candidates = nodes.filter(node => node.root).map(root => {
    const scope = selection.scopes.get(root.scope)!;
    const remaining = selectedClosure(scope, [...scope.roots].filter(id => id !== root.id));
    const removed = nodes.filter(node => node.scope === root.scope && !remaining.has(node.id));
    return { ref: root.ref, root_instruction_bytes: root.instruction_bytes,
      released_nodes: removed.map(node => node.id),
      released_instruction_bytes: removed.some(node => node.instruction_bytes === null) ? null
        : removed.reduce((sum, node) => sum + (node.instruction_bytes ?? 0), 0),
      retained_as_required: remaining.has(root.id) };
  });
  return { version: 1, kind: "working_set", scope: "notion_instruction_graphs", roots: nodes.filter(node => node.root).map(node => node.ref), nodes,
    context: activeContextClosures(ctx, projected, pending).map(root => ({ ...root, complete: root.missing.length === 0 })),
    active: { nodes: nodes.length, instruction_bytes, visible_instruction_bytes: nodes.filter(node => node.visible).reduce((sum, node) => sum + (node.instruction_bytes ?? 0), 0) },
    history: { versions: active.history.size, unique_instruction_bytes: [...active.history.values()].reduce((sum, source) => sum + source.bytes, 0) },
    budget: { max_instruction_bytes: limit, status: instruction_bytes === null ? "unknown" : limit !== null && instruction_bytes > limit ? "exceeded" : "within",
      unit: "utf8_bytes", automatic_eviction: false },
    release_candidates,
    session_effects: { notion_writes: "none", history_changed: false, cache_reclaimed: false } };
}

export class WorkingSetBudgetError extends Error {
  readonly code = "SOURCE_WORKING_SET_BUDGET";
  readonly details: { working_set: ReturnType<typeof exportWorkingSet>; effects?: ConsumptionEffects };
  constructor(report: ReturnType<typeof exportWorkingSet>, effects?: ConsumptionEffects) {
    super("The complete root/Requires working set exceeds its session budget. Release an unused root or explicitly change the budget; no instructions were truncated.");
    this.details = { working_set: report, ...(effects ? { effects } : {}) };
  }
}

export function assertWorkingSetBudget(ctx: ExtensionContext, pending: PendingGraphs, effects?: ConsumptionEffects): void {
  const report = exportWorkingSet(ctx, [], pending);
  if (report.budget.max_instruction_bytes !== null && report.budget.status !== "within")
    throw new WorkingSetBudgetError(report, effects);
}

export function setWorkingSetBudget(api: ExtensionAPI, ctx: ExtensionContext, bytes: number | null): boolean {
  if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes <= 0)) throw failure("INVALID_ARGUMENT", "max_bytes must be a positive integer or null");
  if (!api.appendEntry || !ctx.sessionManager?.getBranch) throw failure("SOURCE_SESSION_UNAVAILABLE", "The host must persist session controls");
  if (workingSetBudget(ctx) === bytes) return false;
  const session = ctx.sessionManager.getSessionId?.();
  api.appendEntry(SESSION_WORKING_SET_BUDGET_ENTRY, { version: 1, max_instruction_bytes: bytes });
  if (session !== ctx.sessionManager.getSessionId?.() || workingSetBudget(ctx) !== bytes) throw failure("SOURCE_SESSION_PERSIST_FAILED", "The session did not confirm its budget change");
  return true;
}

export function releaseWorkingSetRoots(api: ExtensionAPI, ctx: ExtensionContext, refs: readonly string[]): { changed: boolean; released: ReleasedRoot[] } {
  if (!refs.length || refs.length > 64) throw failure("INVALID_ARGUMENT", "Release one to 64 explicit fixed root refs");
  if (!api.appendEntry || !ctx.sessionManager?.getBranch) throw failure("SOURCE_SESSION_UNAVAILABLE", "The host must persist session controls");
  const active = activeSources(ctx), roots: ReleasedRoot[] = [];
  for (const ref of refs) {
    const requested = parseNativeReference(ref);
    if (!requested.snapshot) throw failure("SOURCE_RELEASE_FIXED_ROOT_REQUIRED", "Copy a fixed root reference from working_set show");
    const candidates = [...active.selection.scopes.values()].flatMap(scope => [...scope.bindings.values(), ...scope.retired.values()]
      .filter(binding => binding.ref === ref).map(binding => ({ scope, binding })));
    const unique = [...new Map(candidates.map(value => [JSON.stringify([value.scope.scope, value.binding.record.id]), value])).values()];
    if (unique.length !== 1) throw failure("SOURCE_RELEASE_ROOT_UNKNOWN", "The fixed root must belong to this session and one source scope");
    const { scope, binding } = unique[0]!;
    const current = scope.bindings.get(binding.record.id);
    if (current && current.ref !== ref) throw failure("SOURCE_RELEASE_STALE_ROOT", "This root now uses a different fixed version. Copy its current ref from working_set show.");
    if (!scope.roots.has(binding.record.id)) {
      if (current) throw failure("SOURCE_RELEASE_REQUIRED", "This Skill is still required by an active root. Release the owning root instead.");
      continue;
    }
    roots.push({ scope: scope.scope, id: binding.record.id });
  }
  if (!roots.length) return { changed: false, released: [] };
  const data = decodeRootRelease({ version: 1, release_id: randomUUID(), roots });
  const session = ctx.sessionManager.getSessionId?.();
  api.appendEntry(SESSION_RELEASE_ENTRY, data);
  if (session !== ctx.sessionManager.getSessionId?.() || !ctx.sessionManager.getBranch().some(entry => entry.type === "custom"
    && entry.customType === SESSION_RELEASE_ENTRY && decodeRootRelease(entry.data).release_id === data.release_id))
    throw failure("SOURCE_SESSION_PERSIST_FAILED", "The session did not confirm the root release");
  return { changed: true, released: data.roots };
}
