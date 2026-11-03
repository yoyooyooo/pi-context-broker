import { randomUUID } from "node:crypto";
import { decodePreparationLock, type PreparationBinding, type PreparationGraphLock, type PreparedHostGraph } from "./prepare-protocol";
import type { AgentMessage, ExtensionAPI, ExtensionContext, SessionEntry, SkillRecord } from "./types";
import { projectSelectedSourceMessages, sourceBodyLoaded } from "./session-source-snapshot";

export const SESSION_GRAPH_ENTRY = "context-broker-selected-graph";
export type SelectionMode = "extend" | "replace";
type SelectionEvent = {
  version: 1; schema_version: 1; compiler_version: 1; selection_id: string;
  mode: SelectionMode; graphs: PreparationGraphLock[];
};
export type SelectedScope = {
  scope: string; bindings: Map<string, PreparationBinding>; retired: Map<string, PreparationBinding>;
  graphs: PreparationGraphLock[]; selectionId: string;
};
export type SessionSelection = { scopes: Map<string, SelectedScope> };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const conflict = () => Object.assign(new Error("Conflicting selected Skill versions in the active branch"), { code: "SOURCE_SESSION_CONFLICT" });
function event(value: unknown): SelectionEvent {
  if (!object(value) || value.version !== 1 || value.schema_version !== 1 || value.compiler_version !== 1
    || typeof value.selection_id !== "string" || !["extend", "replace"].includes(String(value.mode))
    || !Array.isArray(value.graphs) || !value.graphs.length) throw Object.assign(new Error("Unsupported session graph entry"), { code: "SOURCE_SESSION_GRAPH_INVALID" });
  return { version: 1, schema_version: 1, compiler_version: 1, selection_id: value.selection_id,
    mode: value.mode === "replace" ? "replace" : "extend", graphs: value.graphs.map(decodePreparationLock) };
}
export function reduceSessionSelection(branch: readonly SessionEntry[]): SessionSelection {
  const scopes = new Map<string, SelectedScope>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== SESSION_GRAPH_ENTRY) continue;
    const selected = event(entry.data);
    const replaced = new Set<string>();
    for (const graph of selected.graphs) {
      let scope = scopes.get(graph.scope);
      if (!scope) {
        scope = { scope: graph.scope, bindings: new Map(), retired: new Map(), graphs: [], selectionId: selected.selection_id };
        scopes.set(graph.scope, scope);
      }
      if (selected.mode === "replace" && !replaced.has(graph.scope)) {
        for (const [id, binding] of scope.bindings) scope.retired.set(id, binding);
        scope.bindings.clear(); scope.graphs = []; replaced.add(graph.scope);
      }
      for (const binding of graph.bindings) {
        const previous = scope.bindings.get(binding.record.id);
        if (previous && (previous.snapshot_id !== binding.snapshot_id || previous.body_sha256 !== binding.body_sha256 || previous.version_id !== binding.version_id)) throw conflict();
        scope.bindings.set(binding.record.id, binding);
      }
      if (!scope.graphs.some(previous => previous.sha256 === graph.sha256)) scope.graphs.push(graph);
      scope.selectionId = selected.selection_id;
    }
  }
  return { scopes };
}
/** All entries is not a branch: siblings must never supply selection state. */
export function sessionSelection(ctx: ExtensionContext): SessionSelection {
  return reduceSessionSelection(ctx.sessionManager?.getBranch?.() ?? []);
}
export function selectedBinding(selection: SessionSelection, record: SkillRecord): PreparationBinding | undefined {
  return record.sourceScope && record.id ? selection.scopes.get(record.sourceScope)?.bindings.get(record.id) : undefined;
}
export function persistSessionSelection(api: ExtensionAPI, ctx: ExtensionContext, graphs: readonly PreparedHostGraph[], mode: SelectionMode): void {
  if (!graphs.length || !api.appendEntry || !ctx.sessionManager?.getBranch) return;
  const data: SelectionEvent = { version: 1, schema_version: 1, compiler_version: 1, selection_id: randomUUID(), mode,
    graphs: graphs.map(graph => decodePreparationLock(graph.lock)) };
  const branch = ctx.sessionManager.getBranch();
  // Validate the complete transition before writing a branch entry.
  reduceSessionSelection([...branch, { type: "custom", customType: SESSION_GRAPH_ENTRY, data }]);
  const current = reduceSessionSelection(branch);
  if (mode === "extend" && data.graphs.every(graph => current.scopes.get(graph.scope)?.graphs.some(previous => previous.sha256 === graph.sha256))) return;
  api.appendEntry(SESSION_GRAPH_ENTRY, data);
}
export function exportSessionSelection(ctx: ExtensionContext, messages: AgentMessage[]) {
  const selection = sessionSelection(ctx);
  const projected = projectSelectedSourceMessages(messages, selection);
  return {
    version: 1, schema_version: 1, compiler_version: 1, kind: "selected_graph",
    scopes: [...selection.scopes.values()].map(scope => ({
      scope: scope.scope, selection_id: scope.selectionId, graph_locks: scope.graphs,
      nodes: [...scope.bindings.values()].map(binding => ({
        binding, selected: true,
        loaded: sourceBodyLoaded(projected, { ...binding.record, source: "notion", sourceId: "session", sourceScope: binding.scope, preparationBinding: binding,
          snapshotId: binding.snapshot_id, path: "", aliases: [], normalizedAliases: [], normalizedName: binding.record.alias,
          normalizedDescription: binding.record.description, autoloadEnabled: true }),
      })),
    })),
  };
}
