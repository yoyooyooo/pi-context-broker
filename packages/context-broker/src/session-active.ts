import { createHash, randomUUID } from "node:crypto";
import { recordIdentity } from "./discovery-records";
import { decodePreparationLock, isPreparationBinding, type PreparationGraphLock } from "./prepare-protocol";
import { applyRootRelease, applySelectionGraphs, samePreparationBinding, SESSION_RELEASE_ENTRY, decodeRootRelease, sessionSelection, type SessionSelection, type SelectionMode, type ReleasedRoot } from "./session-graph";
import { sourceBodyLoaded, sourceContentIdentity, sourceDeliveryLoaded } from "./session-source-snapshot";
import type { AgentMessage, ExtensionAPI, ExtensionContext, SessionEntry, SkillRecord } from "./types";

/** Prepared/selected graphs are not activation. Only a successful, uncancelled
 * provider response may append this confirmation of a complete delivery. */
export const SESSION_ACTIVE_ENTRY = "context-broker-active-sources";
export type ActiveSource = {
  identity: string; contentIdentity: string; snapshotId: string; bodySha256: string; bytes: number;
  record: SkillRecord;
};
type Activation = {
  version: 1; schema_version: 1; compiler_version: 1; activation_id: string;
  mode: SelectionMode; graphs: PreparationGraphLock[]; sources: ActiveSource[]; selected_roots?: ReleasedRoot[];
};
export type ActiveSources = { sources: Map<string, ActiveSource>; history: Map<string, ActiveSource>; selection: SessionSelection };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => Object.assign(new Error("Invalid active Skill delivery receipt"), { code: "SOURCE_SESSION_ACTIVE_INVALID" });

function decode(value: unknown): Activation {
  if (!object(value) || value.version !== 1 || value.schema_version !== 1 || value.compiler_version !== 1
    || typeof value.activation_id !== "string" || !["extend", "replace"].includes(String(value.mode))
    || !Array.isArray(value.graphs) || !Array.isArray(value.sources)) throw invalid();
  const graphs = value.graphs.map(decodePreparationLock);
  if (graphs.some(graph => graph.purpose !== "use")) throw invalid();
  const sources = value.sources.map((source: unknown): ActiveSource => {
    if (!object(source) || !object(source.record) || typeof source.identity !== "string" || typeof source.contentIdentity !== "string"
      || typeof source.snapshotId !== "string" || !/^(s_|local_)[a-f0-9]{64}$/.test(source.snapshotId)
      || typeof source.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.bodySha256)
      || !Number.isSafeInteger(source.bytes) || Number(source.bytes) <= 0) throw invalid();
    const record = source.record;
    if (record.body !== undefined || typeof record.name !== "string" || typeof record.path !== "string"
      || typeof record.sourceId !== "string" || !record.sourceId || !["notion", "local", "filesystem"].includes(String(record.source))
      || !Array.isArray(record.aliases) || !record.aliases.every(alias => typeof alias === "string")
      || typeof record.normalizedName !== "string" || !Array.isArray(record.normalizedAliases)
      || typeof record.normalizedDescription !== "string" || typeof record.autoloadEnabled !== "boolean" || record.kind === "prompt") throw invalid();
    // The structural fields above establish SkillRecord's required metadata;
    // exact remote identity is additionally validated by the protocol decoder.
    const metadata = record as SkillRecord;
    if (recordIdentity(metadata) !== source.identity || sourceContentIdentity(metadata) !== source.contentIdentity) throw invalid();
    if (metadata.source === "notion") {
      const binding = metadata.preparationBinding;
      if (!isPreparationBinding(binding) || binding.scope !== metadata.sourceScope || binding.record.id !== metadata.id
        || binding.snapshot_id !== source.snapshotId || binding.body_sha256 !== source.bodySha256
        || !graphs.some(graph => graph.bindings.some(value => samePreparationBinding(value, binding)))) throw invalid();
    }
    return { identity: source.identity, contentIdentity: source.contentIdentity, snapshotId: source.snapshotId,
      bodySha256: source.bodySha256, bytes: Number(source.bytes), record: metadata };
  });
  for (const graph of graphs) for (const binding of graph.bindings) {
    if (!sources.some(source => source.record.preparationBinding && samePreparationBinding(source.record.preparationBinding, binding))) throw invalid();
  }
  const selected_roots = value.selected_roots === undefined ? undefined
    : decodeRootRelease({ version: 1, release_id: value.activation_id, roots: value.selected_roots }).roots;
  if (selected_roots?.some(root => !graphs.some(graph => graph.scope === root.scope && graph.roots.includes(root.id)))) throw invalid();
  return { version: 1, schema_version: 1, compiler_version: 1, activation_id: value.activation_id,
    mode: value.mode === "replace" ? "replace" : "extend", graphs, sources, ...(selected_roots ? { selected_roots } : {}) };
}

export function reduceActiveSources(branch: readonly SessionEntry[]): ActiveSources {
  const sources = new Map<string, ActiveSource>(), history = new Map<string, ActiveSource>();
  let selection: SessionSelection = { scopes: new Map() };
  const prune = () => {
    for (const [identity, source] of sources) {
      if (source.record.source !== "notion") continue;
      const binding = source.record.sourceScope && selection.scopes.get(source.record.sourceScope)?.bindings.get(source.record.id!);
      if (!binding || !source.record.preparationBinding || !samePreparationBinding(binding, source.record.preparationBinding)) sources.delete(identity);
    }
  };
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === SESSION_RELEASE_ENTRY) {
      applyRootRelease(selection, decodeRootRelease(entry.data));
      prune();
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== SESSION_ACTIVE_ENTRY) continue;
    const activation = decode(entry.data);
    selection = applySelectionGraphs(selection, { graphs: activation.graphs, mode: activation.mode,
      selectionId: activation.activation_id, selectedRoots: activation.selected_roots });
    for (const source of activation.sources) {
      sources.set(source.contentIdentity, source);
      history.set(JSON.stringify([source.contentIdentity, source.snapshotId, source.bodySha256]), source);
    }
    prune();
  }
  return { sources, history, selection };
}
export function activeSources(ctx: ExtensionContext): ActiveSources {
  return reduceActiveSources(ctx.sessionManager?.getBranch?.() ?? []);
}

export function activeSelection(ctx: ExtensionContext, pending: readonly { graphs: readonly { lock: PreparationGraphLock }[]; mode: SelectionMode }[] = []): SessionSelection {
  let selection = activeSources(ctx).selection;
  for (const transition of pending) {
    selection = applySelectionGraphs(selection, { graphs: transition.graphs.map(value => value.lock).filter(graph => graph.purpose === "use"),
      mode: transition.mode, selectionId: "pending-provider" });
  }
  return selection;
}

/** The request has completed its cancellable acquisition and received 2xx
 * response headers. A ready tool result or graph lock alone never calls this. */
export function confirmActiveSources(api: ExtensionAPI, ctx: ExtensionContext, records: readonly SkillRecord[], messages: AgentMessage[]): void {
  if (!api.appendEntry || !ctx.sessionManager?.getBranch) return;
  const candidates = new Map(records.filter(record => record.sourceId && record.kind !== "prompt" && record.body
    && sourceBodyLoaded(messages, record)).map(record => [sourceContentIdentity(record), record]));
  const selected = sessionSelection(ctx), active = activeSources(ctx);
  const graphs = [...selected.scopes.values()].flatMap(scope => scope.graphs).filter(graph => graph.purpose === "use"
    && graph.bindings.every(binding => {
      const record = candidates.get(JSON.stringify([binding.scope, binding.record.id]));
      return record?.snapshotId === binding.snapshot_id && hash(record.body!) === binding.body_sha256
        && !!record.preparationBinding && samePreparationBinding(record.preparationBinding, binding);
    }));
  const recordsForGraph = new Set(graphs.flatMap(graph => graph.bindings.map(binding => JSON.stringify([binding.scope, binding.record.id]))));
  const sources: ActiveSource[] = [...candidates].filter(([identity, record]) => record.source !== "notion" || recordsForGraph.has(identity)).map(([contentIdentity, record]) => {
    const { body, ...metadata } = record;
    const bodySha256 = hash(body!);
    return { identity: recordIdentity(record), contentIdentity, snapshotId: record.snapshotId ?? "local_" + bodySha256,
      bodySha256, bytes: Buffer.byteLength(body!), record: metadata };
  });
  const selected_roots = [...selected.scopes.values()].flatMap(scope => [...scope.roots]
    .filter(id => graphs.some(graph => graph.scope === scope.scope && graph.roots.includes(id))).map(id => ({ scope: scope.scope, id })));
  if (!sources.length || sources.every(source => {
    const previous = active.sources.get(source.contentIdentity);
    return previous?.snapshotId === source.snapshotId && previous.bodySha256 === source.bodySha256;
  }) && selected_roots.every(root => active.selection.scopes.get(root.scope)?.roots.has(root.id))
    && graphs.every(graph => active.selection.scopes.get(graph.scope)?.graphs.some(previous => previous.sha256 === graph.sha256))) return;
  const mode: SelectionMode = graphs.length ? "replace" : "extend";
  const data = decode({ version: 1, schema_version: 1, compiler_version: 1, activation_id: randomUUID(), mode, graphs, sources,
    ...(selected_roots.length ? { selected_roots } : {}) });
  reduceActiveSources([...ctx.sessionManager.getBranch(), { type: "custom", customType: SESSION_ACTIVE_ENTRY, data }]);
  api.appendEntry(SESSION_ACTIVE_ENTRY, data);
}

export function missingActiveSources(ctx: ExtensionContext, messages: AgentMessage[], pending: readonly { graphs: readonly { lock: PreparationGraphLock }[]; mode: SelectionMode }[] = []): ActiveSource[] {
  const effective = activeSelection(ctx, pending);
  return [...activeSources(ctx).sources.values()].filter(source => {
    const scope = source.record.sourceScope && effective.scopes.get(source.record.sourceScope);
    const selected = scope && scope.bindings.get(source.record.id!);
    if (scope && (!selected || !source.record.preparationBinding || !samePreparationBinding(selected, source.record.preparationBinding))) return false;
    return !sourceDeliveryLoaded(messages, source);
  });
}
export function assertRestoredSource(source: ActiveSource, record: SkillRecord): SkillRecord {
  if (sourceContentIdentity(record) !== source.contentIdentity || record.kind === "prompt" || typeof record.body !== "string"
    || hash(record.body) !== source.bodySha256 || Buffer.byteLength(record.body) !== source.bytes
    || record.source === "notion" && record.snapshotId !== source.snapshotId) throw Object.assign(new Error("Active Skill restoration did not match its fixed delivery"), { code: "SOURCE_IDENTITY_MISMATCH" });
  return record;
}
