import { createHash } from "node:crypto";
import type { PreparationDirectory, PreparationPurpose } from "./prepare-protocol";
import type { ContentRecord } from "./types";

/** This compiler changes the host envelope, never the CLI's source projection. */
export const SKILL_PREPARATION_COMPILER = "context-broker/skill-prepare/v1" as const;
export type SkillPreparationBodySpan = { start: number; end: number; encoding: "json" };
export type SkillPreparationModelDirectory = {
  files: readonly { path: string; ref: string; bytes: number }[];
  required: readonly SkillPreparationModelRelation[];
  candidates: readonly SkillPreparationModelRelation[];
  references: readonly SkillPreparationModelRelation[];
};
export type SkillPreparationModelRelation = {
  ref: string; kind: string; name: string; description: string; availability: string;
};
export type SkillPreparationModel = {
  ok: true; status: "ready"; purpose: PreparationPurpose; roots: readonly string[];
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
  derived?: { reason: "deduplicate" | "supersede"; parentSha256: string };
};
export type SkillPreparationCompilationInput = {
  purpose: PreparationPurpose; roots: readonly string[];
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

function modelDirectory(value: PreparationDirectory): SkillPreparationModelDirectory {
  const relation = ({ ref, kind, name, description, availability }: PreparationDirectory["required"][number]) =>
    ({ ref, kind, name, description, availability });
  return {
    files: value.files.map(({ path, ref, bytes }) => ({ path, ref, bytes })),
    required: value.required.map(relation), candidates: value.candidates.map(relation), references: value.references.map(relation),
  };
}

/** Exact generated schema. Author content is only ever an opaque string. */
export function isSkillPreparationModel(value: unknown): value is SkillPreparationModel {
  if (!object(value) || !keys(value, ["ok", "status", "purpose", "roots", "records"])
    || value.ok !== true || value.status !== "ready" || value.purpose !== "use" && value.purpose !== "inspect"
    || !Array.isArray(value.roots) || !value.roots.length || value.roots.some(ref => typeof ref !== "string" || !ref)
    || new Set(value.roots).size !== value.roots.length || !Array.isArray(value.records) || !value.records.length) return false;
  const relation = (item: unknown) => object(item) && keys(item, ["ref", "kind", "name", "description", "availability"])
    && ["ref", "kind", "name", "description", "availability"].every(key => typeof item[key] === "string");
  const records = value.records;
  for (const record of records) {
    if (!object(record) || !keys(record, ["name", "kind", "ref", "content", "directory"])
      || typeof record.name !== "string" || typeof record.kind !== "string" || !["skill", "router", "prompt"].includes(record.kind)
      || typeof record.ref !== "string" || !record.ref || typeof record.content !== "string") return false;
    if (record.directory !== undefined) {
      const directory = record.directory;
      if (!object(directory) || !keys(directory, ["files", "required", "candidates", "references"])
        || !Array.isArray(directory.files) || directory.files.some(file => !object(file) || !keys(file, ["path", "ref", "bytes"])
          || typeof file.path !== "string" || typeof file.ref !== "string" || !natural(file.bytes))
        || ["required", "candidates", "references"].some(key => {
          const entries = directory[key];
          return !Array.isArray(entries) || !entries.every(relation);
        })) return false;
    }
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
  return { content: content + "]}", bodySpans };
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
        ...(record.directory === undefined ? {} : { directory: modelDirectory(record.directory) }) };
    }),
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
