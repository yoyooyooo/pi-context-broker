import { randomUUID } from "node:crypto";
import { decodePreparationLock, type PreparationBinding, type PreparationGraphLock, type PreparedHostGraph } from "./prepare-protocol";
import type { AgentMessage, ExtensionAPI, ExtensionContext, SessionEntry, SkillRecord } from "./types";
import { projectSelectedSourceMessages, sourceBodyLoaded } from "./session-source-snapshot";

export const SESSION_GRAPH_ENTRY = "context-broker-selected-graph";
export const SESSION_RELEASE_ENTRY = "context-broker-released-roots";
export type ReleasedRoot = { scope: string; id: string };
type ReleaseEvent = { version: 1; release_id: string; roots: ReleasedRoot[] };
export type SelectionMode = "extend" | "replace";
type SelectionEvent = {
  version: 1; schema_version: 1; compiler_version: 1; selection_id: string;
  mode: SelectionMode; graphs: PreparationGraphLock[]; selected_roots?: ReleasedRoot[];
};
export type SelectedScope = {
  scope: string; bindings: Map<string, PreparationBinding>; retired: Map<string, PreparationBinding>;
  graphs: PreparationGraphLock[]; roots: Set<string>; selectionId: string;
};
export type SessionSelection = { scopes: Map<string, SelectedScope> };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const conflict = () => Object.assign(new Error("Conflicting selected Skill versions in the active branch"), { code: "SOURCE_SESSION_CONFLICT" });
export function decodeRootRelease(value: unknown): ReleaseEvent {
  if (!object(value) || value.version !== 1 || typeof value.release_id !== "string" || !value.release_id
    || !Array.isArray(value.roots) || !value.roots.length || value.roots.length > 64) throw Object.assign(new Error("Invalid Skill root release"), { code: "SOURCE_SESSION_RELEASE_INVALID" });
  const roots = value.roots.map((root: unknown) => {
    if (!object(root) || typeof root.scope !== "string" || !/^[a-f0-9]{64}$/.test(root.scope) || typeof root.id !== "string" || !root.id)
      throw Object.assign(new Error("Invalid Skill root release"), { code: "SOURCE_SESSION_RELEASE_INVALID" });
    return { scope: root.scope, id: root.id };
  });
  return { version: 1, release_id: value.release_id, roots };
}
/** Derive the selected closure from immutable graph locks. Releasing one root
 * never edits a lock or drops a node still required by another root. */
export function selectedClosure(scope: SelectedScope, roots: Iterable<string> = scope.roots): Set<string> {
  const required = scope.graphs.flatMap(graph => graph.purpose === "use" ? graph.required : []);
  const closure = new Set(roots), pending = [...closure];
  for (let index = 0; index < pending.length; index++) for (const edge of required) {
    if (edge.from === pending[index] && !closure.has(edge.to)) { closure.add(edge.to); pending.push(edge.to); }
  }
  return closure;
}
export function applyRootRelease(selection: SessionSelection, release: ReleaseEvent): void {
  for (const root of release.roots) {
    const scope = selection.scopes.get(root.scope);
    if (scope) scope.roots.delete(root.id);
  }
  for (const scope of selection.scopes.values()) {
    const needed = selectedClosure(scope);
    for (const [id, binding] of scope.bindings) if (!needed.has(id)) { scope.retired.set(id, binding); scope.bindings.delete(id); }
    scope.graphs = scope.graphs.filter(graph => graph.roots.some(id => scope.roots.has(id)));
    scope.selectionId = release.release_id;
  }
}
function event(value: unknown): SelectionEvent {
  if (!object(value) || value.version !== 1 || value.schema_version !== 1 || value.compiler_version !== 1
    || typeof value.selection_id !== "string" || !["extend", "replace"].includes(String(value.mode))
    || !Array.isArray(value.graphs) || !value.graphs.length) throw Object.assign(new Error("Unsupported session graph entry"), { code: "SOURCE_SESSION_GRAPH_INVALID" });
  const graphs = value.graphs.map(decodePreparationLock);
  const selected_roots = value.selected_roots === undefined ? undefined
    : decodeRootRelease({ version: 1, release_id: value.selection_id, roots: value.selected_roots }).roots;
  if (selected_roots?.some(root => !graphs.some(graph => graph.scope === root.scope && graph.roots.includes(root.id)))) throw conflict();
  return { version: 1, schema_version: 1, compiler_version: 1, selection_id: value.selection_id,
    mode: value.mode === "replace" ? "replace" : "extend", graphs, ...(selected_roots ? { selected_roots } : {}) };
}
export function reduceSessionSelection(branch: readonly SessionEntry[]): SessionSelection {
  const scopes = new Map<string, SelectedScope>();
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === SESSION_RELEASE_ENTRY) {
      applyRootRelease({ scopes }, decodeRootRelease(entry.data));
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== SESSION_GRAPH_ENTRY) continue;
    const selected = event(entry.data);
    const replaced = new Set<string>();
    for (const graph of selected.graphs) {
      let scope = scopes.get(graph.scope);
      if (!scope) {
        scope = { scope: graph.scope, bindings: new Map(), retired: new Map(), graphs: [], roots: new Set(), selectionId: selected.selection_id };
        scopes.set(graph.scope, scope);
      }
      if (selected.mode === "replace" && !replaced.has(graph.scope)) {
        for (const [id, binding] of scope.bindings) scope.retired.set(id, binding);
        scope.bindings.clear(); scope.graphs = []; scope.roots.clear(); replaced.add(graph.scope);
      }
      for (const binding of graph.bindings) {
        const previous = scope.bindings.get(binding.record.id);
        if (previous && (previous.snapshot_id !== binding.snapshot_id || previous.body_sha256 !== binding.body_sha256 || previous.version_id !== binding.version_id)) throw conflict();
        scope.bindings.set(binding.record.id, binding);
      }
      if (!scope.graphs.some(previous => previous.sha256 === graph.sha256)) scope.graphs.push(graph);
      for (const id of graph.roots) if (!selected.selected_roots || selected.selected_roots.some(root => root.scope === graph.scope && root.id === id)) scope.roots.add(id);
      scope.selectionId = selected.selection_id;
    }
    for (const scope of scopes.values()) {
      const needed = selectedClosure(scope);
      for (const [id, binding] of scope.bindings) if (!needed.has(id)) { scope.retired.set(id, binding); scope.bindings.delete(id); }
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
  if (mode === "extend" && data.graphs.every(graph => current.scopes.get(graph.scope)?.graphs.some(previous => previous.sha256 === graph.sha256)
    && graph.roots.every(id => current.scopes.get(graph.scope)?.roots.has(id)))) return;
  api.appendEntry(SESSION_GRAPH_ENTRY, data);
}
export function exportSessionSelection(ctx: ExtensionContext, messages: AgentMessage[]) {
  const selection = sessionSelection(ctx);
  const projected = projectSelectedSourceMessages(messages, selection);
  return {
    version: 1, schema_version: 1, compiler_version: 1, kind: "selected_graph",
    scopes: [...selection.scopes.values()].map(scope => ({
      scope: scope.scope, selection_id: scope.selectionId, graph_locks: scope.graphs,
      roots: [...scope.roots],
      nodes: [...scope.bindings.values()].map(binding => ({
        binding, selected: true,
        loaded: sourceBodyLoaded(projected, { ...binding.record, source: "notion", sourceId: "session", sourceScope: binding.scope, preparationBinding: binding,
          snapshotId: binding.snapshot_id, path: "", aliases: [], normalizedAliases: [], normalizedName: binding.record.alias,
          normalizedDescription: binding.record.description, autoloadEnabled: true }),
      })),
    })),
  };
}
