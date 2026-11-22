import type { SkillRecord } from "./types";

export type ExactNativeReference = { selector: string; path: string; snapshot?: string; fileId?: string };
export type NativeFileBinding = { file_id: string; page_id: string; path: string };

/** A relative Notion read names the actual containing file, independently of
 * filesystem materialization. Path interpretation belongs to the shared SDK. */
export function relativeReadInput(input: Record<string, unknown>): { from: string; path: string } | undefined {
  if (!Object.hasOwn(input, "from")) return undefined;
  const { from, path } = input;
  if (typeof from !== "string" || typeof path !== "string" || !path.trim()
    || path.startsWith("/") || path.startsWith("~") || /[\\:?#\p{Cc}\p{Cf}\p{Cs}]/u.test(path)
    || Object.hasOwn(input, "paths") || input.refresh === true) throw invalid();
  if (!/^sr:[SR][A-Za-z0-9_-]{22}$/.test(from)) {
    const reference = parseNativeReference(from);
    if (!reference.selector.startsWith("shared_skill:") || !reference.snapshot || !reference.path) throw invalid();
  }
  return { from, path };
}

function invalid(): Error {
  return Object.assign(new Error("Invalid exact Skill reference"), { code: "SOURCE_REFERENCE_INVALID" });
}

/** Decode the CLI reference wire format without interpreting names or aliases. */
export function parseNativeReference(value: string): ExactNativeReference {
  const match = /^skill:\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/.exec(value);
  if (!match) throw invalid();
  try {
    const selector = decodeURIComponent(match[1]!);
    const path = decodeURIComponent(match[2] ?? "");
    if (!selector || /[\/\p{Cc}\p{Cf}\p{Cs}]/u.test(selector)
      || /[\\:\p{Cc}\p{Cf}\p{Cs}]/u.test(path)
      || path.split("/").some(part => part === "." || part === "..")
      || path.startsWith("/") || path.includes("//")) throw invalid();
    const query = new URLSearchParams(match[3] ?? "");
    if ([...query.keys()].some(key => key !== "snapshot" && key !== "file_id")
      || query.getAll("snapshot").length > 1 || query.getAll("file_id").length > 1) throw invalid();
    const snapshot = query.get("snapshot") ?? undefined;
    const fileId = query.get("file_id") ?? undefined;
    if (snapshot !== undefined && !/^s_[a-f0-9]{64}$/.test(snapshot)) throw invalid();
    if (fileId !== undefined && (!selector.startsWith("shared_skill:") || !path || !fileId
      || fileId.trim() !== fileId || fileId.length > 256 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(fileId))) throw invalid();
    return { selector, path, ...(snapshot === undefined ? {} : { snapshot }), ...(fileId === undefined ? {} : { fileId }) };
  } catch { throw invalid(); }
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

/** Stable file identity wins over its former path; the selected snapshot owns the binding. */
export function nativeResourcePath(reference: ExactNativeReference, record: SkillRecord): string {
  if (!record.ref || parseNativeReference(record.ref).selector !== reference.selector) throw invalid();
  if (reference.snapshot && record.snapshotId !== reference.snapshot) {
    throw Object.assign(new Error("Requested snapshot does not match the selected owner"), { code: "SOURCE_IDENTITY_MISMATCH" });
  }
  if (reference.fileId === undefined) return reference.path || record.entrypoint || "SKILL.md";
  const bindings = record.fileBindings?.filter(binding => binding.file_id === reference.fileId) ?? [];
  if (bindings.length !== 1) {
    throw Object.assign(new Error("Stable File binding is unavailable in this snapshot"), { code: "SHARED_FILE_BINDING_UNAVAILABLE" });
  }
  const binding = bindings[0]!;
  if (record.fileBindings?.some(other => other !== binding && (other.page_id === binding.page_id || other.path === binding.path))) {
    throw Object.assign(new Error("Stable File binding is ambiguous"), { code: "SHARED_FILE_ID_CONFLICT" });
  }
  return binding.path;
}
