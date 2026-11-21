import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
const conflict = (details?: { scope: string; id: string; reason: "binding" | "requires"; roots: ReleasedRoot[] }) => Object.assign(
  new Error("Conflicting selected Skill versions in the active branch. Refresh the affected roots together or explicitly release a retained root."),
  { code: "SOURCE_SESSION_CONFLICT", ...(details ? { details: { ...details, next: "refresh_related_roots_or_release" } } : {}) });
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
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
  return closure(roots, required);
}
function closure(roots: Iterable<string>, required: PreparationGraphLock["required"]): Set<string> {
  const closure = new Set(roots), pending = [...closure];
  for (let index = 0; index < pending.length; index++) for (const edge of required) {
    if (edge.from === pending[index] && !closure.has(edge.to)) { closure.add(edge.to); pending.push(edge.to); }
  }
  return closure;
}
/** Retain only roots and their complete closure from a verified lock. The
 * original receipt stays immutable; the projected vector receives its own proof. */
function projectGraph(graph: PreparationGraphLock, selected: ReadonlySet<string>): PreparationGraphLock | undefined {
  const roots = graph.roots.filter(id => selected.has(id));
  if (!roots.length) return undefined;
  const needed = closure(roots, graph.purpose === "use" ? graph.required : []);
  const bindings = graph.bindings.filter(binding => needed.has(binding.record.id));
  if (bindings.length !== needed.size) throw conflict();
  const required = graph.required.filter(edge => needed.has(edge.from));
  const { sha256: _sha256, ...original } = graph;
  const vector = { ...original, roots, bindings, required };
  return decodePreparationLock({ ...vector, sha256: createHash("sha256").update(canonical(vector)).digest("hex") });
}
function pruneScope(scope: SelectedScope): void {
  scope.graphs = scope.graphs.flatMap(graph => {
    const projected = projectGraph(graph, scope.roots);
    return projected ? [projected] : [];
  });
  const needed = selectedClosure(scope);
  for (const [id, binding] of scope.bindings) if (!needed.has(id)) { scope.retired.set(id, binding); scope.bindings.delete(id); }
}
export function samePreparationBinding(a: PreparationBinding, b: PreparationBinding): boolean {
  return a.scope === b.scope && a.snapshot_id === b.snapshot_id && a.version_id === b.version_id
    && a.body_sha256 === b.body_sha256 && a.ref === b.ref && a.record.id === b.record.id
    && a.record.kind === b.record.kind && a.record.entrypoint === b.record.entrypoint && a.record.ref === b.record.ref
    && isDeepStrictEqual(a.record.locator, b.record.locator);
}
export type SelectedTaskRole = { roles: readonly ["root"]; required_by?: never }
  | { roles: readonly ["required"] | readonly ["root", "required"]; required_by: readonly string[] };
/** Presentation of the supplied verified use graph, never a new selection or
 * delivery authority. Inspect locks and same-owner different versions do not qualify. */
export function selectedTaskRole(selection: SessionSelection, binding: PreparationBinding): SelectedTaskRole | undefined {
  const scope = selection.scopes.get(binding.scope), selected = scope?.bindings.get(binding.record.id);
  if (!scope || !selected || !samePreparationBinding(selected, binding)) return undefined;
  const roots = [...scope.roots].filter(root => scope.graphs.some(graph => graph.purpose === "use" && graph.roots.includes(root)));
  const required_by = roots.filter(root => root !== binding.record.id && selectedClosure(scope, [root]).has(binding.record.id))
    .flatMap(root => { const owner = scope.bindings.get(root); return owner ? [owner.ref] : []; }).sort();
  if (roots.includes(binding.record.id)) return required_by.length ? { roles: ["root", "required"], required_by } : { roles: ["root"] };
  return required_by.length ? { roles: ["required"], required_by } : undefined;
}
const outgoing = (graph: PreparationGraphLock, id: string) => canonical(graph.required.filter(edge => edge.from === id)
  .map((edge): [string, string] => [edge.to, edge.ref]).sort(([a, ar], [b, br]) => a < b ? -1 : a > b ? 1 : ar < br ? -1 : ar > br ? 1 : 0));
function graphConflict(scope: SelectedScope, graph: PreparationGraphLock, id: string, reason: "binding" | "requires") {
  const roots = new Set([...scope.roots].filter(root => selectedClosure(scope, [root]).has(id)));
  for (const root of graph.roots) if (closure([root], graph.purpose === "use" ? graph.required : []).has(id)) roots.add(root);
  return conflict({ scope: scope.scope, id, reason, roots: [...roots].sort().map(id => ({ scope: scope.scope, id })) });
}
/** One atomic transition for selected, pending and confirmed graphs. Replacement
 * owns only the requested roots, never every root in an authenticated scope. */
export function applySelectionGraphs(selection: SessionSelection, transition: {
  graphs: readonly PreparationGraphLock[]; mode: SelectionMode; selectionId: string; selectedRoots?: readonly ReleasedRoot[];
}): SessionSelection {
  const scopes = new Map([...selection.scopes].map(([key, scope]) => [key, { ...scope, bindings: new Map(scope.bindings),
    retired: new Map(scope.retired), graphs: [...scope.graphs], roots: new Set(scope.roots) }]));
  const graphs = transition.graphs.map(decodePreparationLock);
  const roots = transition.selectedRoots ?? graphs.flatMap(graph => graph.roots.map(id => ({ scope: graph.scope, id })));
  if (roots.some(root => !graphs.some(graph => graph.scope === root.scope && graph.roots.includes(root.id)))) throw conflict();
  if (transition.mode === "replace") {
    for (const root of roots) scopes.get(root.scope)?.roots.delete(root.id);
    for (const scope of scopes.values()) pruneScope(scope);
  }
  for (const original of graphs) {
    const graph = projectGraph(original, new Set(roots.filter(root => root.scope === original.scope).map(root => root.id)));
    if (!graph) continue;
    let scope = scopes.get(graph.scope);
    if (!scope) {
      scope = { scope: graph.scope, bindings: new Map(), retired: new Map(), graphs: [], roots: new Set(), selectionId: transition.selectionId };
      scopes.set(graph.scope, scope);
    }
    for (const binding of graph.bindings) {
      const previous = scope.bindings.get(binding.record.id);
      if (previous && !samePreparationBinding(previous, binding)) throw graphConflict(scope, graph, binding.record.id, "binding");
      if (graph.purpose === "use" && scope.graphs.some(previous => previous.purpose === "use"
        && previous.bindings.some(value => value.record.id === binding.record.id) && outgoing(previous, binding.record.id) !== outgoing(graph, binding.record.id)))
        throw graphConflict(scope, graph, binding.record.id, "requires");
      scope.bindings.set(binding.record.id, binding);
    }
    if (!scope.graphs.some(previous => previous.sha256 === graph.sha256)) scope.graphs.push(graph);
    for (const id of graph.roots) scope.roots.add(id);
    scope.selectionId = transition.selectionId;
  }
  for (const scope of scopes.values()) pruneScope(scope);
  return { scopes };
}
export function applyRootRelease(selection: SessionSelection, release: ReleaseEvent): void {
  for (const root of release.roots) {
    const scope = selection.scopes.get(root.scope);
    if (scope) scope.roots.delete(root.id);
  }
  for (const scope of selection.scopes.values()) {
    pruneScope(scope);
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
  let selection: SessionSelection = { scopes: new Map() };
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === SESSION_RELEASE_ENTRY) {
      applyRootRelease(selection, decodeRootRelease(entry.data));
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== SESSION_GRAPH_ENTRY) continue;
    const selected = event(entry.data);
    selection = applySelectionGraphs(selection, { graphs: selected.graphs, mode: selected.mode, selectionId: selected.selection_id, selectedRoots: selected.selected_roots });
  }
  return selection;
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
