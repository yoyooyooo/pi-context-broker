import type { SkillRecord } from "./types";

export type ExactNativeReference = { selector: string; path: string; snapshot?: string; fileId?: string };
export type NativeFileBinding = { file_id: string; page_id: string; path: string };

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
