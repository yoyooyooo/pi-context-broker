import { Schema } from "effect";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseNativeReference } from "./native-reference";
import type { ContentRecord, SkillRecord } from "./types";

export type PreparationPurpose = "use" | "inspect";
export type PreparationBudget = { maxNodes?: number; maxDepth?: number; maxInstructionBytes?: number; maxContextBytes?: number };
export type PreparationDirectory = {
  files: readonly { path: string; bytes: number; sha256: string; ref: string }[];
  required: readonly PreparationDirectoryEntry[]; candidates: readonly PreparationDirectoryEntry[]; references: readonly PreparationDirectoryEntry[];
};
export type PreparationDirectoryEntry = { id: string; ref: string; kind: string; name: string; description: string; availability: string };
export type PreparationBinding = { record: ContentRecord; scope: string; snapshot_id: string; version_id: string; body_sha256: string; ref: string };
export type PreparationGraphLock = {
  version: 1; kind: "observed_version_vector"; purpose: PreparationPurpose; scope: string; roots: readonly string[];
  required: readonly { from: string; to: string; ref: string }[]; bindings: readonly PreparationBinding[]; sha256: string;
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function isContentRecord(value: unknown): value is ContentRecord {
  if (!object(value) || !["skill", "router", "prompt"].includes(String(value.kind))
    || ["id", "name", "alias", "description", "entrypoint", "ref"].some(key => typeof value[key] !== "string")
    || typeof value.default_context !== "boolean" || value.enabled !== undefined && typeof value.enabled !== "boolean"
    || value.upstream !== undefined && (!object(value.upstream) || typeof value.upstream.repo !== "string")
    || !object(value.locator)) return false;
  const locator = value.locator;
  if (locator.type === "local") return typeof locator.id === "string" && typeof locator.entry === "string";
  if (typeof locator.database_id !== "string" || typeof locator.data_source_id !== "string") return false;
  if (locator.type === "notion_subscription") return typeof locator.subscription_id === "string" && typeof locator.target_database_id === "string";
  return typeof locator.page_id === "string" && (locator.type === "notion_page"
    || locator.type === "shared_skill" && typeof locator.library_id === "string" && typeof locator.skill_id === "string");
}
export function isPreparationBinding(value: unknown): value is PreparationBinding {
  return object(value) && isContentRecord(value.record) && typeof value.scope === "string" && /^[a-f0-9]{64}$/.test(value.scope)
    && typeof value.snapshot_id === "string" && /^s_[a-f0-9]{64}$/.test(value.snapshot_id) && typeof value.body_sha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.body_sha256) && typeof value.version_id === "string" && typeof value.ref === "string";
}
export type PreparedHostGraph = {
  purpose: PreparationPurpose; scope: string; sourceId: string; roots: string[];
  records: SkillRecord[]; bindings: PreparationBinding[]; lock: PreparationGraphLock;
  budget: Required<PreparationBudget>;
  usage: { prepared_nodes: number; instruction_bytes: number; context_bytes: number; max_depth: number };
};
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Snapshot = Schema.String.check(Schema.isPattern(/^s_[a-f0-9]{64}$/u));
const Natural = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Positive = Natural.check(Schema.isGreaterThan(0));
const Purpose = Schema.Literals(["use", "inspect"]);
const Binding = Schema.Struct({ record: Schema.Unknown, scope: Sha, snapshot_id: Snapshot, version_id: Schema.String, body_sha256: Sha, ref: Schema.String });
const Edge = Schema.Struct({ from: Schema.String, to: Schema.String, ref: Schema.String });
const DirectoryEntry = Schema.Struct({ id: Schema.String, ref: Schema.String, kind: Schema.String, name: Schema.String, description: Schema.String, availability: Schema.String });
const Freshness = Schema.Struct({
  policy: Schema.Literals(["default", "max_age", "refresh", "offline", "pinned"]),
  validated_at: Schema.optional(Schema.String), age_ms: Schema.optional(Schema.Number),
  max_age_ms: Schema.optional(Schema.Number), stale: Schema.optional(Schema.Boolean),
  validation: Schema.optional(Schema.Literal("metadata")),
});
const Node = Schema.Union([
  Schema.Struct({ state: Schema.Literal("prepared"), id: Schema.String, ref: Schema.String, roles: Schema.Array(Schema.String),
    record: Schema.Unknown, binding: Binding, path: Schema.String, content: Schema.String, bytes: Natural, body_sha256: Sha,
    files: Schema.Array(Schema.Struct({ path: Schema.String, bytes: Natural, sha256: Sha, ref: Schema.String })),
    required: Schema.Array(DirectoryEntry), candidates: Schema.Array(DirectoryEntry), references: Schema.Array(DirectoryEntry),
    source: Schema.optional(Schema.Literals(["notion", "local_cache", "local_snapshot"])), freshness: Schema.optional(Freshness) }),
  Schema.Struct({ state: Schema.Literal("known"), id: Schema.String, ref: Schema.String, roles: Schema.Array(Schema.String) }),
]);
const Lock = Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("observed_version_vector"), purpose: Purpose, scope: Sha,
  roots: Schema.Array(Schema.String), required: Schema.Array(Edge), bindings: Schema.Array(Binding), sha256: Sha });
const Ready = Schema.Struct({
  ok: Schema.Literal(true), version: Schema.Literal(1), status: Schema.Literal("ready"), purpose: Purpose, scope: Sha,
  roots: Schema.Array(Schema.Struct({ target: Schema.String, id: Schema.String, ref: Schema.String, readiness: Schema.Literal("ready") })),
  nodes: Schema.Array(Node), required: Schema.Array(Edge), required_closure: Schema.Array(Schema.String),
  session_bindings: Schema.Array(Binding), graph_lock: Lock,
  budget: Schema.Struct({ maxNodes: Positive, maxDepth: Natural, maxInstructionBytes: Positive, maxContextBytes: Positive }),
  usage: Schema.Struct({ prepared_nodes: Natural, instruction_bytes: Natural, context_bytes: Natural, max_depth: Natural }),
});
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
// Wire lock canonicalization only; dependency resolution remains entirely in the CLI.
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
}
function invalid(): never { throw Object.assign(new Error("CLI preparation receipt is inconsistent"), { code: "SOURCE_PREPARATION_INVALID" }); }
export function decodePreparationLock(value: unknown): PreparationGraphLock {
  const decoded = Schema.decodeUnknownSync(Lock)(value);
  const bindings = decoded.bindings.map(binding => { if (!isPreparationBinding(binding)) invalid(); return binding; });
  const { sha256, ...vector } = decoded;
  if (hash(canonical(vector)) !== sha256 || bindings.some(binding => binding.scope !== decoded.scope)
    || new Set(bindings.map(binding => binding.record.id)).size !== bindings.length
    || decoded.roots.some(id => !bindings.some(binding => binding.record.id === id))) invalid();
  for (const binding of bindings) {
    const ref = parseNativeReference(binding.ref), record = parseNativeReference(binding.record.ref);
    if (ref.selector !== record.selector || ref.snapshot !== binding.snapshot_id || ref.path !== binding.record.entrypoint) invalid();
  }
  return { ...decoded, bindings };
}
function sameRecord(a: ContentRecord, b: ContentRecord): boolean {
  return a.id === b.id && a.kind === b.kind && a.ref === b.ref && a.entrypoint === b.entrypoint && isDeepStrictEqual(a.locator, b.locator);
}
export function decodePreparedGraph(value: unknown, input: { purpose: PreparationPurpose; roots: readonly SkillRecord[] }, decodeRecord: (value: unknown) => ContentRecord) {
  const ready = Schema.decodeUnknownSync(Ready)(value);
  const rootIds = [...new Set(input.roots.map(record => record.id))].sort();
  if (ready.purpose !== input.purpose || !input.roots.length || input.roots.some(record => record.sourceScope !== ready.scope)
    || !isDeepStrictEqual([...new Set(ready.roots.map(root => root.id))].sort(), rootIds)) invalid();
  const bindings: PreparationBinding[] = ready.session_bindings.map(binding => ({ ...binding, record: decodeRecord(binding.record) }));
  const nodes = ready.nodes.flatMap(node => {
    if (node.state !== "prepared") return [];
    const record = decodeRecord(node.record), binding = { ...node.binding, record: decodeRecord(node.binding.record) };
    const ref = parseNativeReference(binding.ref);
    if (node.id !== record.id || record.enabled === false || node.path !== record.entrypoint
      || !sameRecord(record, binding.record) || binding.scope !== ready.scope || ref.snapshot !== binding.snapshot_id
      || ref.selector !== parseNativeReference(record.ref).selector || ref.path !== record.entrypoint
      || node.ref !== binding.ref || node.body_sha256 !== binding.body_sha256
      || hash(node.content) !== node.body_sha256 || Buffer.byteLength(node.content) !== node.bytes
      || !bindings.some(item => isDeepStrictEqual(item, binding))) invalid();
    return [{ ...node, record, binding }];
  });
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length || bindings.length !== nodes.length || rootIds.some(id => !id || !ids.has(id))
    || ready.required_closure.some(id => !ids.has(id)) || nodes.some(node => !rootIds.includes(node.id) && !ready.required_closure.includes(node.id))
    || ready.required.some(edge => !ids.has(edge.from) || input.purpose === "use" && !ids.has(edge.to))
    || input.purpose === "inspect" && ready.required_closure.length
    || ready.usage.prepared_nodes !== nodes.length || ready.usage.instruction_bytes !== nodes.reduce((n, node) => n + node.bytes, 0)
    || ready.usage.prepared_nodes > ready.budget.maxNodes || ready.usage.max_depth > ready.budget.maxDepth
    || nodes.some(node => node.bytes > ready.budget.maxInstructionBytes) || ready.usage.context_bytes > ready.budget.maxContextBytes) invalid();
  for (const root of input.roots) {
    const node = nodes.find(node => node.id === root.id);
    if (!node || !root.locator || !root.ref || node.record.kind !== root.kind || node.record.entrypoint !== root.entrypoint
      || node.record.ref !== root.ref || !isDeepStrictEqual(node.record.locator, root.locator)) invalid();
  }
  const { sha256, ...vector } = ready.graph_lock;
  if (vector.purpose !== input.purpose || vector.scope !== ready.scope || !isDeepStrictEqual(vector.roots, rootIds)
    || !isDeepStrictEqual(vector.required, ready.required) || !isDeepStrictEqual(vector.bindings, ready.session_bindings)
    || hash(canonical(vector)) !== sha256) invalid();
  return { ...ready, nodes, session_bindings: bindings, graph_lock: { ...ready.graph_lock, bindings } };
}

/** Expose failure provenance and budgets without forwarding raw response bodies or URLs. */
export type PreparationDenial = { scope: string; id: string; ref: string; code: "CONTENT_DISABLED" | "ACCESS_DENIED" | "AUTH_REQUIRED" };
export function preparationFailureDetails(value: unknown): { preparation?: unknown; retry_after?: number; denials?: readonly PreparationDenial[] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Record<string, unknown>;
  const retry = typeof details.retry_after === "number" && Number.isFinite(details.retry_after) ? details.retry_after : undefined;
  const raw = details.preparation;
  if (!raw || typeof raw !== "object") return retry === undefined ? undefined : { retry_after: retry };
  const preparation = raw as Record<string, unknown>;
  const nodes = Array.isArray(preparation.nodes) ? preparation.nodes.filter(object) : [];
  const denials: PreparationDenial[] = [];
  if (typeof preparation.scope === "string" && /^[a-f0-9]{64}$/.test(preparation.scope)) {
    const errors = [...nodes.filter(node => node.state === "failed").map(node => ({ node, error: node.error })),
      ...(Array.isArray(preparation.errors) ? preparation.errors.filter(object).map(error => ({ node: undefined, error })) : [])];
    for (const item of errors) {
      const error = item.error;
      if (!object(error)) continue;
      const code = error.code;
      if (code !== "CONTENT_DISABLED" && code !== "ACCESS_DENIED" && code !== "AUTH_REQUIRED") continue;
      const identity = object(error.details) ? error.details.id : undefined;
      const target = typeof identity === "string" ? nodes.find(node => node.id === identity) : item.node;
      if (!target || typeof target.id !== "string" || typeof target.ref !== "string") continue;
      // A parent's error can originate in a child. Retain only the exact
      // failing node or explicit dependency identity, never the root guess.
      if (target.state !== "failed") continue;
      if (!denials.some(value => value.id === target.id && value.code === code))
        denials.push({ scope: preparation.scope, id: target.id, ref: target.ref, code });
    }
  }
  return {
    ...(retry === undefined ? {} : { retry_after: retry }),
    ...(denials.length ? { denials } : {}),
    preparation: {
      version: preparation.version, status: preparation.status, purpose: preparation.purpose, scope: preparation.scope,
      budget: preparation.budget, usage: preparation.usage,
      errors: Array.isArray(preparation.errors) ? preparation.errors.flatMap(error => error && typeof error === "object"
        && "code" in error && typeof error.code === "string" ? [{ code: error.code, ...("target" in error && typeof error.target === "string" ? { target: error.target } : {}) }] : []) : [],
    },
  };
}
