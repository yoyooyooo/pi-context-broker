import type { NativeReadResult, SkillRecord } from "./types";

type ReadDisplayTarget =
  | { readonly kind: "skill"; readonly ref: string }
  | { readonly kind: "file"; readonly files: readonly { readonly ref: string; readonly path: string }[] };

/** Presentation only. Source identity, authorization and read receipts stay separate. */
export type ReadDisplaySnapshot = Readonly<{
  version: 1;
  source: "notion";
  name: string;
  sourceId: string;
  scope: string;
  sourceLabel?: string;
}> & ReadDisplayTarget;

export function notionReadDisplay(record: SkillRecord, target: ReadDisplayTarget,
  catalog: Iterable<SkillRecord>): ReadDisplaySnapshot | undefined {
  if (record.source !== "notion" || (record.kind ?? "skill") !== "skill"
    || !record.name.trim() || !record.sourceId || !record.sourceScope) return undefined;
  const duplicates = [...catalog].filter(other => other.source === "notion" && other.name === record.name
    && (other.sourceId !== record.sourceId || other.sourceScope !== record.sourceScope || other.id !== record.id));
  const sourceLabel = !duplicates.length ? undefined : duplicates.some(other => other.sourceId === record.sourceId)
    ? `${record.sourceId} · ${duplicates.some(other => other.sourceScope === record.sourceScope && other.sourceId === record.sourceId) ? record.id : record.sourceScope}`
    : record.sourceId;
  return { version: 1, source: "notion", name: record.name, sourceId: record.sourceId, scope: record.sourceScope,
    ...(sourceLabel ? { sourceLabel } : {}), ...target };
}

export function withReadDisplay(result: NativeReadResult, display: ReadDisplaySnapshot | undefined): NativeReadResult {
  if (!display || result.details !== undefined && (result.details === null || typeof result.details !== "object" || Array.isArray(result.details))) return result;
  return { ...result, details: { ...result.details, contextBrokerReadDisplay: display } };
}
