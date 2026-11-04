import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  isSkillPreparationModel, renderSkillPreparationModel, SKILL_PREPARATION_COMPILER,
  type SkillPreparationModel, type SkillPreparationProjection,
} from "./skill-context-projection";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const digest = (value: unknown): value is { sha256: string; bytes: number } => object(value)
  && keys(value, ["sha256", "bytes"]) && sha(value.sha256) && natural(value.bytes);

function model(text: string): { value: SkillPreparationModel; bodySpans: ReturnType<typeof renderSkillPreparationModel>["bodySpans"] } | undefined {
  try {
    // The renderer validates the public model shape, then reconstructs its exact
    // canonical representation. Parsing arbitrary author tags is never involved.
    const value: unknown = JSON.parse(text);
    if (!isSkillPreparationModel(value)) return undefined;
    const rendered = renderSkillPreparationModel(value);
    return rendered.content === text ? { value, bodySpans: rendered.bodySpans } : undefined;
  } catch { return undefined; }
}

/** Validate the actual model-visible text, not a detached planned projection.
 * Offsets are UTF-16 string positions; all byte counts and digests are UTF-8. */
export function validateSkillPrepareProjection(text: string, value: unknown): SkillPreparationProjection | undefined {
  if (!object(value) || !keys(value, ["version", "compiler", "sourceProjection", "rendered", "records", "derived"])
    || value.version !== 1 || value.compiler !== SKILL_PREPARATION_COMPILER || value.sourceProjection !== "source-identity/v1"
    || !digest(value.rendered) || value.rendered.sha256 !== hash(text) || value.rendered.bytes !== Buffer.byteLength(text)
    || !Array.isArray(value.records) || !value.records.length) return undefined;
  if (value.derived !== undefined && (!object(value.derived) || !keys(value.derived, ["reason", "parentSha256"])
    || !["deduplicate", "supersede"].includes(String(value.derived.reason)) || !sha(value.derived.parentSha256))) return undefined;
  const parsed = model(text);
  if (!parsed || parsed.value.records.length !== value.records.length) return undefined;
  for (const [index, item] of value.records.entries()) {
    const record = parsed.value.records[index]!, span = parsed.bodySpans[index]!;
    if (!object(item) || !keys(item, ["index", "ref", "source", "rendered", "delivery", "state"])
      || item.index !== index || item.ref !== record.ref || !object(item.source)
      || !keys(item.source, ["identity", "sha256", "bytes"]) || typeof item.source.identity !== "string" || !item.source.identity
      || !sha(item.source.sha256) || !natural(item.source.bytes) || !digest(item.rendered)
      || !isDeepStrictEqual(item.delivery, span) || !["source", "replaced"].includes(String(item.state))) return undefined;
    const delivered = text.slice(span.start, span.end);
    if (item.rendered.sha256 !== hash(delivered) || item.rendered.bytes !== Buffer.byteLength(delivered)) return undefined;
    if (item.state === "source") {
      if (hash(record.content) !== item.source.sha256 || Buffer.byteLength(record.content) !== item.source.bytes) return undefined;
    } else if (value.derived === undefined) return undefined;
  }
  // All unknown fields and runtime invariants above were checked before exposing
  // the typed immutable receipt to session code.
  return value as SkillPreparationProjection;
}

/** Derive a new provider-only receipt after replacing explicitly selected body
 * spans. A parent hash alone grants nothing: the complete parent must validate,
 * every non-body field stays identical, and untouched bodies stay identical. */
export function deriveSkillPrepareProjection(
  beforeText: string,
  afterText: string,
  value: unknown,
  changedIndices: readonly number[],
  reason: "deduplicate" | "supersede",
): SkillPreparationProjection | undefined {
  const before = validateSkillPrepareProjection(beforeText, value), parsedBefore = model(beforeText), parsedAfter = model(afterText);
  if (!before || !parsedBefore || !parsedAfter || !["deduplicate", "supersede"].includes(reason)
    || !changedIndices.length || changedIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= before.records.length)
    || new Set(changedIndices).size !== changedIndices.length || parsedBefore.value.records.length !== parsedAfter.value.records.length) return undefined;
  const changed = new Set(changedIndices);
  const withoutBodies = (input: SkillPreparationModel) => ({ ...input, records: input.records.map(({ content: _content, ...record }) => record) });
  if (!isDeepStrictEqual(withoutBodies(parsedBefore.value), withoutBodies(parsedAfter.value))) return undefined;
  if (parsedBefore.value.records.some((record, index) => !changed.has(index) && record.content !== parsedAfter.value.records[index]!.content)) return undefined;
  const projection: SkillPreparationProjection = {
    ...before,
    rendered: { sha256: hash(afterText), bytes: Buffer.byteLength(afterText) },
    records: before.records.map((record, index) => {
      const delivery = parsedAfter.bodySpans[index]!, body = afterText.slice(delivery.start, delivery.end);
      return { ...record, source: { ...record.source }, delivery,
        rendered: { sha256: hash(body), bytes: Buffer.byteLength(body) },
        state: changed.has(index) ? "replaced" : record.state };
    }),
    derived: { reason, parentSha256: before.rendered.sha256 },
  };
  return validateSkillPrepareProjection(afterText, projection);
}
