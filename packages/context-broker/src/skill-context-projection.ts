import { createHash } from "node:crypto";
import type { PreparationDirectory, PreparationPurpose } from "./prepare-protocol";
import type { ContentRecord } from "./types";
import { consumptionEffects, isConsumptionEffects, type ConsumptionEffects } from "./consumption-effects.ts";
import { parseNativeReference } from "./native-reference";

/** This compiler changes the host envelope, never the CLI's source projection. */
export const SKILL_PREPARATION_COMPILER = "context-broker/skill-prepare/v1" as const;
export type SkillPreparationBodySpan = { start: number; end: number; encoding: "json" };
export type SkillPreparationModelDirectory = {
  files: readonly { path: string; ref: string; bytes: number; description?: string }[];
  required: readonly SkillPreparationModelRelation[];
  candidates: readonly SkillPreparationModelRelation[];
  references: readonly (SkillPreparationModelRelation | { ref: string })[];
};
export type SkillPreparationModelRelation = {
  ref: string; kind: string; name: string; description: string; availability: string;
};
export type SkillPreparationModel = {
  ok: true; status: "ready"; purpose: PreparationPurpose; roots: readonly string[];
  effects?: ConsumptionEffects;
  records: readonly {
    name: string; kind: ContentRecord["kind"]; ref: string; content: string;
    directory?: SkillPreparationModelDirectory;
  }[];
};
export type SkillPreparationSourceIdentity = { identity: string; sha256: string; bytes: number };
export type SkillPreparationProjectionRecord = {
  index: number; ref: string; source: SkillPreparationSourceIdentity;
  /** UTF-8 of the JSON string interior, including escapes and excluding quotes. */
  rendered: { sha256: string; bytes: number };
  /** JavaScript UTF-16 offsets into the complete rendered tool text. */
  delivery: SkillPreparationBodySpan;
  state: "source" | "replaced";
};
export type SkillPreparationProjection = {
  version: 1; compiler: typeof SKILL_PREPARATION_COMPILER; sourceProjection: "source-identity/v1";
  rendered: { sha256: string; bytes: number };
  records: readonly SkillPreparationProjectionRecord[];
  derived?: { reason: "deduplicate" | "supersede"; parentSha256: string;
    directories?: readonly { index: number; sha256: string; bytes: number }[] };
};
export type SkillPreparationCompilationInput = {
  purpose: PreparationPurpose; roots: readonly string[];
  effects?: ConsumptionEffects;
  records: readonly {
    name: string; kind: ContentRecord["kind"]; ref: string; content: string;
    source: SkillPreparationSourceIdentity; directory?: PreparationDirectory;
  }[];
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const measure = (value: string) => ({ sha256: sha256(value), bytes: Buffer.byteLength(value) });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function invalid(): never {
  throw Object.assign(new Error("Skill preparation projection is inconsistent"), { code: "SOURCE_CONTEXT_PROJECTION_INVALID" });
}

export function projectSkillDirectory(value: PreparationDirectory | undefined): SkillPreparationModelDirectory | undefined {
  if (value === undefined) return undefined;
  const relation = ({ ref, kind, name, description, availability }: PreparationDirectory["required"][number]) =>
    ({ ref, kind, name, description, availability });
  return compactSkillDirectory({
    files: value.files.map(({ path, ref, bytes }) => ({ path, ref, bytes })),
    required: value.required.map(relation), candidates: value.candidates.map(relation), references: value.references.map(relation),
  });
}

/** A verified exact file reference shares its existing file object. Unfixed,
 * foreign and unavailable references retain their independent full cards. */
export function compactSkillDirectory(value: SkillPreparationModelDirectory): SkillPreparationModelDirectory {
  const descriptions = new Map<string, string>();
  for (const reference of value.references) {
    if (!("kind" in reference) || reference.kind !== "file" || reference.availability !== "available") continue;
    if (!/^sr:R[A-Za-z0-9_-]{22}$/.test(reference.ref)) {
      try { if (!parseNativeReference(reference.ref).snapshot) continue; }
      catch { continue; }
    }
    const matches = value.files.filter(file => file.ref === reference.ref && file.path === reference.name);
    if (matches.length !== 1 || value.references.some(other => other.ref === reference.ref
      && "description" in other && other.description !== reference.description)) continue;
    descriptions.set(reference.ref, reference.description);
  }
  if (!descriptions.size) return value;
  return { ...value,
    files: value.files.map(file => descriptions.has(file.ref) ? { ...file, description: descriptions.get(file.ref)! } : file),
    references: value.references.map(reference => descriptions.has(reference.ref) && "kind" in reference
      && reference.kind === "file" && reference.availability === "available"
      && value.files.some(file => file.ref === reference.ref && file.path === reference.name) ? { ref: reference.ref } : reference),
  };
}

export function isSkillPreparationDirectory(value: unknown): value is SkillPreparationModelDirectory {
  const relation = (item: unknown) => object(item) && keys(item, ["ref", "kind", "name", "description", "availability"])
    && ["ref", "kind", "name", "description", "availability"].every(key => typeof item[key] === "string");
  return object(value) && keys(value, ["files", "required", "candidates", "references"])
    && Array.isArray(value.files) && value.files.every(file => object(file) && keys(file, ["path", "ref", "bytes", "description"])
      && typeof file.path === "string" && typeof file.ref === "string" && natural(file.bytes)
      && (file.description === undefined || typeof file.description === "string"))
    && ["required", "candidates"].every(key => Array.isArray(value[key]) && value[key].every(relation))
    && Array.isArray(value.references) && value.references.every(reference => relation(reference)
      || object(reference) && Object.keys(reference).length === 1 && typeof reference.ref === "string"
      && Array.isArray(value.files) && value.files.filter(file => object(file) && file.ref === reference.ref
        && typeof file.description === "string").length === 1);
}

/** Exact generated schema. Author content is only ever an opaque string. */
export function isSkillPreparationModel(value: unknown): value is SkillPreparationModel {
  if (!object(value) || !keys(value, ["ok", "status", "purpose", "roots", "records", "effects"])
    || value.effects !== undefined && !isConsumptionEffects(value.effects)
    || value.ok !== true || value.status !== "ready" || value.purpose !== "use" && value.purpose !== "inspect"
    || !Array.isArray(value.roots) || !value.roots.length || value.roots.some(ref => typeof ref !== "string" || !ref)
    || new Set(value.roots).size !== value.roots.length || !Array.isArray(value.records) || !value.records.length) return false;
  const records = value.records;
  for (const record of records) {
    if (!object(record) || !keys(record, ["name", "kind", "ref", "content", "directory"])
      || typeof record.name !== "string" || typeof record.kind !== "string" || !["skill", "router", "prompt"].includes(record.kind)
      || typeof record.ref !== "string" || !record.ref || typeof record.content !== "string") return false;
    if (record.directory !== undefined && !isSkillPreparationDirectory(record.directory)) return false;
  }
  return value.roots.every(ref => records.some(record => object(record) && record.ref === ref));
}

/** Render and record offsets while appending; never search author text for markers. */
export function renderSkillPreparationModel(model: SkillPreparationModel): { content: string; bodySpans: SkillPreparationBodySpan[] } {
  if (!isSkillPreparationModel(model)) invalid();
  let content = '{"ok":true,"status":"ready","purpose":' + JSON.stringify(model.purpose)
    + ',"roots":' + JSON.stringify(model.roots) + ',"records":[';
  const bodySpans: SkillPreparationBodySpan[] = [];
  for (const [index, record] of model.records.entries()) {
    if (index) content += ",";
    content += '{"name":' + JSON.stringify(record.name) + ',"kind":' + JSON.stringify(record.kind)
      + ',"ref":' + JSON.stringify(record.ref) + ',"content":"';
    const start = content.length;
    content += JSON.stringify(record.content).slice(1, -1);
    bodySpans.push({ start, end: content.length, encoding: "json" });
    content += '"' + (record.directory === undefined ? "" : ',"directory":' + JSON.stringify(record.directory)) + "}";
  }
  return { content: content + "]" + (model.effects === undefined ? "" : ',"effects":' + JSON.stringify(model.effects)) + "}", bodySpans };
}

export function compileSkillPreparation(input: SkillPreparationCompilationInput): {
  content: string; projection: SkillPreparationProjection; bodySpans: SkillPreparationBodySpan[];
} {
  const model: SkillPreparationModel = {
    ok: true, status: "ready", purpose: input.purpose, roots: [...input.roots],
    records: input.records.map(record => {
      if (typeof record.source.identity !== "string" || !record.source.identity || !/^[a-f0-9]{64}$/.test(record.source.sha256) || !natural(record.source.bytes)
        || sha256(record.content) !== record.source.sha256 || Buffer.byteLength(record.content) !== record.source.bytes) invalid();
      return { name: record.name, kind: record.kind, ref: record.ref, content: record.content,
        ...(record.directory === undefined ? {} : { directory: projectSkillDirectory(record.directory) }) };
    }),
    effects: consumptionEffects(input.effects),
  };
  const rendered = renderSkillPreparationModel(model);
  const projection: SkillPreparationProjection = {
    version: 1, compiler: SKILL_PREPARATION_COMPILER, sourceProjection: "source-identity/v1", rendered: measure(rendered.content),
    records: input.records.map((record, index) => {
      const delivery = rendered.bodySpans[index]!;
      return { index, ref: record.ref, source: { ...record.source },
        rendered: measure(rendered.content.slice(delivery.start, delivery.end)), delivery: { ...delivery }, state: "source" };
    }),
  };
  return { ...rendered, projection };
}
