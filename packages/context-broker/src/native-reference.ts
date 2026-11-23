import type { SkillRecord } from "./types";
import { skillRefProtocol } from "./skill-ref-protocol.ts";

/** Host projection only. selector is a canonical root URI, or a physical page
 * adapter input before qualification. The shared protocol owns its grammar. */
export type ExactNativeReference = { selector: string; path: string; snapshot?: string };
export type NativeFileBinding = { file_id: string; page_id: string; path: string };

/** A relative Notion read names the actual containing file, independently of
 * filesystem materialization. Path interpretation belongs to the shared SDK. */
export function relativeReadInput(input: Record<string, unknown>): { from: string; path: string } | undefined {
  if (!Object.hasOwn(input, "from")) return undefined;
  const { from, path } = input;
  if (typeof from !== "string" || typeof path !== "string" || !path.trim()
    || path.startsWith("/") || path.startsWith("~") || /[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(path)
    || Object.hasOwn(input, "paths") || input.refresh === true) throw invalid();
  if (path.startsWith("skill://")) parseNativeReference(path);
  else if (/[:?#]/u.test(path)) throw invalid();
  if (!/^sr:[SR][A-Za-z0-9_-]{22}$/.test(from)) {
    const reference = parseNativeReference(from);
    if (!hasExactNativeOwner(reference) || !reference.snapshot || !reference.path) throw invalid();
  }
  return { from, path };
}

function invalid(): Error {
  return Object.assign(new Error("Invalid exact Skill reference"), { code: "SOURCE_REFERENCE_INVALID" });
}

/** Decode the CLI reference wire format without interpreting names or aliases. */
export function parseNativeReference(value: string): ExactNativeReference {
  const protocol = skillRefProtocol();
  try {
    const parsed = protocol.parseSkillRef(value);
    const selector = protocol.formatSkillRef({ ...parsed, path: "", selection: { kind: "current" } });
    const snapshot = protocol.skillRefSnapshot(parsed);
    return { selector, path: parsed.path, ...(snapshot === undefined ? {} : { snapshot }) };
  } catch { throw invalid(); }
}

export function formatNativeReference(reference: ExactNativeReference): string {
  const protocol = skillRefProtocol(), owner = protocol.parseSkillRef(reference.selector);
  return protocol.formatSkillRef({ ...owner, path: reference.path,
    selection: reference.snapshot === undefined ? { kind: "current" } : { kind: "fixed", snapshotId: reference.snapshot } });
}
export function nativeFileRef(identity: string, path: string, snapshot?: string): string {
  skillRefProtocol().parseSkillIdentity(identity);
  return formatNativeReference({ selector: identity, path, ...(snapshot === undefined ? {} : { snapshot }) });
}
export function nativeSkillId(libraryId: string, skillId: string): string {
  return skillRefProtocol().formatSkillIdentity({ libraryId, skillId });
}
export function withNativeSnapshot(value: string, snapshot: string): string {
  return formatNativeReference({ ...parseNativeReference(value), snapshot });
}
export function hasExactNativeOwner(reference: ExactNativeReference): boolean {
  const protocol = skillRefProtocol();
  try { protocol.parseSkillIdentity(reference.selector); return true; } catch { return false; }
}
export function nativeReferenceLibrary(reference: ExactNativeReference): string {
  return skillRefProtocol().parseSkillIdentity(reference.selector).libraryId;
}
export function bindNativeReference(reference: ExactNativeReference, libraryId: string): ExactNativeReference {
  const protocol = skillRefProtocol();
  return parseNativeReference(protocol.formatSkillRef(protocol.bindSkillRef(
    protocol.parseSkillRef(formatNativeReference(reference)), libraryId)));
}

/** A public Notion page address selects a physical page, never its v query's View. */
export function notionPageId(value: string): string | undefined {
  const uuid = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu;
  let id = value;
  if (!uuid.test(id)) {
    try {
      if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return undefined;
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || !/(^|\.)notion\.(com|site|so)$/u.test(url.hostname)
        || url.username || url.password || url.port) return undefined;
      const segment = url.pathname.replace(/\/$/u, "").split("/").at(-1) ?? "";
      id = /(?:^|-)([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.exec(segment)?.[1] ?? "";
    } catch { return undefined; }
  }
  if (!uuid.test(id)) return undefined;
  const compact = id.replaceAll("-", "").toLowerCase();
  return [compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16), compact.slice(16, 20), compact.slice(20)].join("-");
}

/** User-facing addresses are normalized before entering the canonical ref protocol. */
export function parseNotionReference(value: string): ExactNativeReference {
  const page = notionPageId(value);
  return page ? { selector: page, path: "" } : parseNativeReference(value);
}

/** A fixed path is interpreted only in its selected owner. Its verified
 * manifest supplies a native File binding or a frozen Source route. */
export function nativeResourcePath(reference: ExactNativeReference, record: SkillRecord): string {
  if (!record.ref || parseNativeReference(record.ref).selector !== reference.selector) throw invalid();
  if (reference.snapshot && record.snapshotId !== reference.snapshot) {
    throw Object.assign(new Error("Requested snapshot does not match the selected owner"), { code: "SOURCE_IDENTITY_MISMATCH" });
  }
  const path = reference.path || record.entrypoint;
  if (!path) throw invalid();
  if (record.entryManifest && record.entryManifest.files.filter(file => file.path === path).length !== 1)
    throw Object.assign(new Error("The selected manifest has no unique file at this path"), { code: "FILE_NOT_FOUND" });
  nativeFileBinding(record, path);
  return path;
}

/** Undefined is valid for a verified Source file without a projected File row. */
export function nativeFileBinding(record: Pick<SkillRecord, "fileBindings">, path: string): NativeFileBinding | undefined {
  const matches = record.fileBindings?.filter(binding => binding.path === path) ?? [];
  if (matches.length > 1) throw Object.assign(new Error("Stable File binding is ambiguous"), { code: "SHARED_FILE_ID_CONFLICT" });
  const binding = matches[0];
  if (binding && record.fileBindings?.some(other => other !== binding && (other.file_id === binding.file_id || other.page_id === binding.page_id)))
    throw Object.assign(new Error("Stable File binding is ambiguous"), { code: "SHARED_FILE_ID_CONFLICT" });
  return binding;
}
