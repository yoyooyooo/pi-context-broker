import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseNativeReference } from "./native-reference";
import type { NativeReadResult } from "./types";
import { isConsumptionEffects, type ConsumptionEffects } from "./consumption-effects.ts";

export const RESOURCE_READ_COMPILER = "context-broker/resource-read/v1" as const;
export type ResourceReadSelection = { scope: string; owner: string; snapshot_id: string; version_id: string };
export type ResourceReadBodySpan = { start: number; end: number; encoding: "json" };
export type ResourceReadModelFile =
  | { kind: "text"; ref: string; path: string; content: string }
  | { kind: "binary"; ref: string; path: string; bytes: number; sha256: string; output: string };
export type ResourceReadModel = { status: "ready"; files: readonly ResourceReadModelFile[]; effects?: ConsumptionEffects };
export type ResourceReadSourceFile = {
  requested_ref: string; ref: string; file_id?: string; path: string; bytes: number; sha256: string;
  encoding: "utf8" | "base64"; content: string; output?: string;
};
export type ResourceReadProofFile = Omit<ResourceReadSourceFile, "content"> & {
  index: number; model_ref: string; loaded: false; delivered_complete_text: boolean;
  state: "source" | "replaced" | "binary"; delivery?: ResourceReadBodySpan;
};
export type ResourceReadProof = {
  version: 2; toolCallId: string; loaded: false; selection: ResourceReadSelection;
  files: readonly ResourceReadProofFile[];
  projection: {
    version: 1; compiler: typeof RESOURCE_READ_COMPILER; rendered: { sha256: string; bytes: number };
    derived?: { reason: "deduplicate"; parentSha256: string };
  };
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const measure = (value: string) => ({ sha256: hash(value), bytes: Buffer.byteLength(value) });
function invalid(): never {
  throw Object.assign(new Error("Resource read projection is inconsistent"), { code: "SOURCE_RESOURCE_PROJECTION_INVALID" });
}

export function isResourceReadModel(value: unknown): value is ResourceReadModel {
  if (!object(value) || !keys(value, ["status", "files", "effects"]) || value.status !== "ready"
    || value.effects !== undefined && !isConsumptionEffects(value.effects)
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 64) return false;
  return value.files.every(file => {
    if (!object(file) || !nonempty(file.ref) || !nonempty(file.path)) return false;
    if (file.kind === "text") return keys(file, ["kind", "ref", "path", "content"]) && typeof file.content === "string";
    return file.kind === "binary" && keys(file, ["kind", "ref", "path", "bytes", "sha256", "output"])
      && natural(file.bytes) && sha(file.sha256) && nonempty(file.output) && isAbsolute(file.output);
  });
}

/** Record offsets while writing the generated envelope. File content remains an
 * opaque string; quotes, author tags, BOM and CRLF cannot become delimiters. */
export function renderResourceReadModel(model: ResourceReadModel): { content: string; bodySpans: Array<ResourceReadBodySpan | undefined> } {
  if (!isResourceReadModel(model)) invalid();
  let content = '{"status":"ready","files":[';
  const bodySpans: Array<ResourceReadBodySpan | undefined> = [];
  for (const [index, file] of model.files.entries()) {
    if (index) content += ",";
    content += '{"kind":' + JSON.stringify(file.kind) + ',"ref":' + JSON.stringify(file.ref) + ',"path":' + JSON.stringify(file.path);
    if (file.kind === "text") {
      content += ',"content":"';
      const start = content.length;
      content += JSON.stringify(file.content).slice(1, -1);
      bodySpans.push({ start, end: content.length, encoding: "json" });
      content += '"}';
    } else {
      bodySpans.push(undefined);
      content += ',"bytes":' + file.bytes + ',"sha256":' + JSON.stringify(file.sha256) + ',"output":' + JSON.stringify(file.output) + "}";
    }
  }
  return { content: content + "]" + (model.effects === undefined ? "" : ',"effects":' + JSON.stringify(model.effects)) + "}", bodySpans };
}

function parsedModel(text: string) {
  try {
    const value: unknown = JSON.parse(text);
    if (!isResourceReadModel(value)) return undefined;
    const rendered = renderResourceReadModel(value);
    return rendered.content === text ? { value, bodySpans: rendered.bodySpans } : undefined;
  } catch { return undefined; }
}

/** Validate bytes from the actual tool text. A resource receipt never grants a
 * main-body delivery, prepared graph, or active session binding. */
export function validateResourceReadProjection(text: string, value: unknown): ResourceReadProof | undefined {
  if (!object(value) || !keys(value, ["version", "toolCallId", "loaded", "selection", "files", "projection"])
    || value.version !== 2 || !nonempty(value.toolCallId) || value.loaded !== false || !object(value.selection)
    || !keys(value.selection, ["scope", "owner", "snapshot_id", "version_id"])
    || !nonempty(value.selection.scope) || !nonempty(value.selection.owner) || !sha(value.selection.version_id)
    || typeof value.selection.snapshot_id !== "string" || !/^s_[a-f0-9]{64}$/.test(value.selection.snapshot_id)
    || !Array.isArray(value.files) || !value.files.length || !object(value.projection)) return undefined;
  const projection = value.projection;
  if (!keys(projection, ["version", "compiler", "rendered", "derived"]) || projection.version !== 1
    || projection.compiler !== RESOURCE_READ_COMPILER || !object(projection.rendered)
    || !keys(projection.rendered, ["sha256", "bytes"]) || projection.rendered.sha256 !== hash(text)
    || projection.rendered.bytes !== Buffer.byteLength(text)) return undefined;
  if (projection.derived !== undefined && (!object(projection.derived) || !keys(projection.derived, ["reason", "parentSha256"])
    || projection.derived.reason !== "deduplicate" || !sha(projection.derived.parentSha256))) return undefined;
  const parsed = parsedModel(text);
  if (!parsed || parsed.value.files.length !== value.files.length) return undefined;
  const paths = new Set<string>(), fileIds = new Set<string>();
  for (const [index, item] of value.files.entries()) {
    const file = parsed.value.files[index]!, span = parsed.bodySpans[index];
    if (!object(item) || !keys(item, ["index", "requested_ref", "ref", "model_ref", "file_id", "path", "bytes", "sha256", "encoding", "output", "loaded", "delivered_complete_text", "state", "delivery"])
      || item.index !== index || item.model_ref !== file.ref || item.path !== file.path || item.loaded !== false
      || !natural(item.bytes) || !sha(item.sha256) || !nonempty(item.ref) || !nonempty(item.requested_ref)
      || item.file_id !== undefined && !nonempty(item.file_id) || paths.has(file.path)
      || typeof item.file_id === "string" && fileIds.has(item.file_id)) return undefined;
    try {
      const ref = parseNativeReference(item.ref), requested = parseNativeReference(item.requested_ref);
      if (ref.selector !== value.selection.owner || ref.snapshot !== value.selection.snapshot_id
        || ref.path !== file.path || ref.fileId !== item.file_id
        || requested.selector !== ref.selector || requested.snapshot !== ref.snapshot
        || requested.fileId !== undefined && requested.fileId !== ref.fileId
        || requested.fileId === undefined && requested.path !== ref.path
        || file.ref !== item.ref && !/^sr:R[A-Za-z0-9_-]{22}$/.test(file.ref)) return undefined;
    } catch { return undefined; }
    paths.add(file.path);
    if (typeof item.file_id === "string") fileIds.add(item.file_id);
    if (file.kind === "text") {
      if (item.encoding !== "utf8" || item.output !== undefined || !span || !isDeepStrictEqual(item.delivery, span)
        || !["source", "replaced"].includes(String(item.state))
        || item.delivered_complete_text !== (item.state === "source")) return undefined;
      if (item.state === "source") {
        if (hash(file.content) !== item.sha256 || Buffer.byteLength(file.content) !== item.bytes) return undefined;
      } else if (projection.derived === undefined) return undefined;
    } else if (item.encoding !== "base64" || item.state !== "binary" || item.delivered_complete_text !== false
      || item.delivery !== undefined || item.bytes !== file.bytes || item.sha256 !== file.sha256 || item.output !== file.output) return undefined;
  }
  return value as ResourceReadProof;
}

export function compileResourceRead(input: {
  toolCallId: string; batch: { selection: ResourceReadSelection; files: readonly ResourceReadSourceFile[] };
  modelRefs: readonly string[]; maxContextBytes: number; effects?: ConsumptionEffects;
}): NativeReadResult & { structuredContent: ResourceReadModel; details: { contextBrokerResource: ResourceReadProof } } {
  if (!nonempty(input.toolCallId) || input.modelRefs.length !== input.batch.files.length
    || !Number.isSafeInteger(input.maxContextBytes) || input.maxContextBytes <= 0) invalid();
  const model: ResourceReadModel = { status: "ready", files: input.batch.files.map((file, index) => {
    if (typeof file.content !== "string") invalid();
    if (file.encoding === "utf8") {
      if (file.output !== undefined || hash(file.content) !== file.sha256 || Buffer.byteLength(file.content) !== file.bytes) invalid();
      return { kind: "text", ref: input.modelRefs[index]!, path: file.path, content: file.content };
    }
    const bytes = Buffer.from(file.content, "base64");
    if (file.encoding !== "base64" || bytes.toString("base64") !== file.content || bytes.length !== file.bytes
      || hash(bytes) !== file.sha256 || !file.output || !isAbsolute(file.output)) invalid();
    return { kind: "binary", ref: input.modelRefs[index]!, path: file.path, bytes: file.bytes, sha256: file.sha256, output: file.output };
  }), ...(input.effects === undefined ? {} : { effects: input.effects }) };
  const rendered = renderResourceReadModel(model);
  if (Buffer.byteLength(rendered.content) > input.maxContextBytes) {
    throw Object.assign(new Error("The complete resource result exceeds the model context byte budget"), {
      code: "RESOURCE_CONTEXT_BUDGET_EXCEEDED", details: { bytes: Buffer.byteLength(rendered.content), maxContextBytes: input.maxContextBytes },
    });
  }
  const proof: ResourceReadProof = {
    version: 2, toolCallId: input.toolCallId, loaded: false, selection: { ...input.batch.selection },
    files: input.batch.files.map(({ content: _content, ...file }, index) => ({ ...file, index, model_ref: input.modelRefs[index]!,
      loaded: false, delivered_complete_text: file.encoding === "utf8", state: file.encoding === "utf8" ? "source" : "binary",
      ...(rendered.bodySpans[index] ? { delivery: rendered.bodySpans[index] } : {}) })),
    projection: { version: 1, compiler: RESOURCE_READ_COMPILER, rendered: measure(rendered.content) },
  };
  if (!validateResourceReadProjection(rendered.content, proof)) invalid();
  return { content: [{ type: "text", text: rendered.content }], structuredContent: model, details: { contextBrokerResource: proof } };
}

/** Recompute only a provider copy. The complete parent must validate, all
 * identities and binary metadata stay equal, and only selected text spans move. */
export function deriveResourceReadProjection(beforeText: string, afterText: string, value: unknown, changedIndices: readonly number[]): ResourceReadProof | undefined {
  const before = validateResourceReadProjection(beforeText, value), parsedBefore = parsedModel(beforeText), parsedAfter = parsedModel(afterText);
  if (!before || !parsedBefore || !parsedAfter || !changedIndices.length || new Set(changedIndices).size !== changedIndices.length
    || changedIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= before.files.length
      || before.files[index]?.state !== "source") || parsedBefore.value.files.length !== parsedAfter.value.files.length) return undefined;
  const changed = new Set(changedIndices);
  const withoutText = (model: ResourceReadModel) => ({ ...model, files: model.files.map(file => {
    if (file.kind !== "text") return file;
    const { content: _content, ...identity } = file;
    return identity;
  }) });
  if (!isDeepStrictEqual(withoutText(parsedBefore.value), withoutText(parsedAfter.value))) return undefined;
  if (parsedBefore.value.files.some((file, index) => file.kind === "text" && !changed.has(index)
    && (!isDeepStrictEqual(file, parsedAfter.value.files[index])))) return undefined;
  const proof: ResourceReadProof = {
    ...before, selection: { ...before.selection },
    files: before.files.map((file, index) => ({ ...file,
      ...(file.encoding === "utf8" ? { delivery: parsedAfter.bodySpans[index]!,
        state: changed.has(index) ? "replaced" as const : file.state,
        delivered_complete_text: changed.has(index) ? false : file.delivered_complete_text } : {}) })),
    projection: { ...before.projection, rendered: measure(afterText), derived: { reason: "deduplicate", parentSha256: before.projection.rendered.sha256 } },
  };
  return validateResourceReadProjection(afterText, proof);
}
