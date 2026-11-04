import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { nativeResourcePath, parseNativeReference, type ExactNativeReference } from "./native-reference";
import { sharedSkillId } from "./shared-skill-identity";
import type { PreparationBinding } from "./prepare-protocol";
import type { ContentLocator, ContentRecord, SessionEntry, SkillRecord } from "./types";

export const SESSION_SHORT_REF_ENTRY = "context-broker-short-ref";
/** Reserve the whole prefix at tool admission, including malformed tokens. */
export const SESSION_SHORT_REF_PREFIX = "sr:";
export type SessionShortRef = `sr:${"C" | "S" | "R"}${string}`;
type RemoteLocator = Exclude<ContentLocator, { type: "local" }>;
export type ShortRefIdentity = Readonly<{
  source: "notion"; scope: string; id: string; kind: ContentRecord["kind"];
  locator: Readonly<RemoteLocator>; ref: string;
}>;
export type CandidateShortRefTarget = Readonly<{ kind: "candidate"; identity: ShortRefIdentity }>;
export type SelectedShortRefTarget = Readonly<{
  kind: "selected"; identity: ShortRefIdentity; snapshot_id: string; version_id: string;
  body_sha256: string; entrypoint: string; ref: string; file_id?: string;
}>;
export type ResourceShortRefTarget = Readonly<{
  kind: "resource"; owner: SessionShortRef; path: string; ref: string;
  bytes: number; sha256: string; file_id?: string;
}>;
export type SessionShortRefTarget = CandidateShortRefTarget | SelectedShortRefTarget | ResourceShortRefTarget;
export type SessionShortRefEvent = Readonly<{ version: 1; ref: SessionShortRef; target: SessionShortRefTarget }>;
export type SessionShortRefState = Readonly<{ bindings: ReadonlyMap<SessionShortRef, SessionShortRefTarget> }>;
export type ShortRefBindingPlan = Readonly<{
  ref: SessionShortRef; event?: SessionShortRefEvent; state: SessionShortRefState;
}>;
export type ResolvedSessionShortRef =
  | Readonly<{ kind: "candidate"; identity: ShortRefIdentity; canonicalRef: string }>
  | Readonly<{ kind: "selected"; selection: SelectedShortRefTarget; canonicalRef: string }>
  | Readonly<{ kind: "resource"; owner: SelectedShortRefTarget; file: ResourceShortRefTarget; canonicalRef: string }>;

const HASH = /^[a-f0-9]{64}$/;
const SNAPSHOT = /^s_[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^sr:[CSR][A-Za-z0-9_-]{22}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function fail(code = "SHORT_REF_INVALID"): never {
  // Never echo an untrusted token, a machine path, or source metadata.
  throw Object.assign(new Error("Skill short reference is unavailable or inconsistent"), { code });
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
}
function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value || value.length > max || value.trim() !== value || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) fail();
  return value;
}
function path(value: unknown): string {
  const result = text(value, 4096);
  if (/[\\:]/.test(result) || result.split("/").some(part => !part || part === "." || part === "..")) fail();
  return result;
}
function reference(value: unknown): ExactNativeReference {
  try { return parseNativeReference(text(value, 8192)); } catch { return fail(); }
}
function canonical(value: ExactNativeReference): string {
  const query = new URLSearchParams();
  if (value.snapshot !== undefined) query.set("snapshot", value.snapshot);
  if (value.fileId !== undefined) query.set("file_id", value.fileId);
  return "skill://" + encodeURIComponent(value.selector)
    + (value.path ? "/" + value.path.split("/").map(encodeURIComponent).join("/") : "")
    + (query.size ? "?" + query.toString() : "");
}
function locator(value: unknown): RemoteLocator {
  if (!object(value)) fail();
  if (value.type === "local") fail("SHORT_REF_UNSUPPORTED");
  if (!["shared_skill", "notion_page", "notion_subscription"].includes(String(value.type))) fail();
  const common = ["type", "database_id", "data_source_id"];
  const extra = value.type === "shared_skill" ? ["page_id", "library_id", "skill_id"]
    : value.type === "notion_page" ? ["page_id"] : ["subscription_id", "target_database_id"];
  fields(value, [...common, ...extra]);
  for (const key of ["database_id", "data_source_id", ...(value.type === "notion_subscription" ? ["subscription_id", "target_database_id"] : ["page_id"])]) {
    if (typeof value[key] !== "string" || !UUID.test(value[key])) fail();
  }
  const database_id = String(value.database_id), data_source_id = String(value.data_source_id);
  if (value.type === "notion_page") return { type: "notion_page", database_id, data_source_id, page_id: String(value.page_id) };
  if (value.type === "notion_subscription") return { type: "notion_subscription", database_id, data_source_id,
    subscription_id: String(value.subscription_id), target_database_id: String(value.target_database_id) };
  const library_id = text(value.library_id), skill_id = text(value.skill_id);
  if (!sharedSkillId(library_id, skill_id)) fail();
  return { type: "shared_skill", database_id, data_source_id, page_id: String(value.page_id), library_id, skill_id };
}
function identity(value: unknown): ShortRefIdentity {
  if (!object(value)) fail();
  fields(value, ["source", "scope", "id", "kind", "locator", "ref"]);
  if (value.source !== "notion" || typeof value.scope !== "string" || !HASH.test(value.scope)
    || !["skill", "router", "prompt"].includes(String(value.kind))) fail();
  const sourceLocator = locator(value.locator), ref = reference(value.ref);
  const id = sourceLocator.type === "shared_skill" ? sharedSkillId(sourceLocator.library_id, sourceLocator.skill_id)!
    : sourceLocator.type + ":" + (sourceLocator.type === "notion_page" ? sourceLocator.page_id : sourceLocator.subscription_id);
  const selector = sourceLocator.type === "shared_skill" ? id : sourceLocator.type === "notion_page" ? sourceLocator.page_id : "upstream:" + sourceLocator.subscription_id;
  if (value.id !== id || ref.selector !== selector || ref.path || ref.snapshot !== undefined || ref.fileId !== undefined
    || sourceLocator.type === "notion_subscription" && value.kind !== "router") fail();
  return Object.freeze({ source: "notion", scope: value.scope, id, kind: value.kind as ContentRecord["kind"],
    locator: Object.freeze(sourceLocator), ref: canonical(ref) });
}
function recordIdentity(record: ContentRecord, scope: string): ShortRefIdentity {
  const ref = reference(record.ref);
  if (ref.path !== path(record.entrypoint) || ref.snapshot !== undefined || ref.fileId !== undefined) fail();
  return identity({ source: "notion", scope, id: record.id, kind: record.kind, locator: record.locator,
    ref: canonical({ selector: ref.selector, path: "" }) });
}
function selected(binding: PreparationBinding): SelectedShortRefTarget {
  return target({ kind: "selected", identity: recordIdentity(binding.record, binding.scope),
    snapshot_id: binding.snapshot_id, version_id: binding.version_id, body_sha256: binding.body_sha256,
    entrypoint: binding.record.entrypoint, ref: binding.ref,
    ...(reference(binding.ref).fileId === undefined ? {} : { file_id: reference(binding.ref).fileId }) }) as SelectedShortRefTarget;
}
function target(value: unknown): SessionShortRefTarget {
  if (!object(value)) fail();
  if (value.kind === "candidate") {
    fields(value, ["kind", "identity"]);
    return Object.freeze({ kind: "candidate", identity: identity(value.identity) });
  }
  if (value.kind === "selected") {
    fields(value, ["kind", "identity", "snapshot_id", "version_id", "body_sha256", "entrypoint", "ref"], ["file_id"]);
    const owner = identity(value.identity), ref = reference(value.ref), entrypoint = path(value.entrypoint);
    if (typeof value.snapshot_id !== "string" || !SNAPSHOT.test(value.snapshot_id)
      || typeof value.body_sha256 !== "string" || !HASH.test(value.body_sha256)
      || ref.selector !== reference(owner.ref).selector || ref.snapshot !== value.snapshot_id || ref.path !== entrypoint
      || ref.fileId !== value.file_id) fail();
    return Object.freeze({ kind: "selected", identity: owner, snapshot_id: value.snapshot_id, version_id: text(value.version_id),
      body_sha256: value.body_sha256, entrypoint, ref: canonical(ref),
      ...(ref.fileId === undefined ? {} : { file_id: ref.fileId }) });
  }
  if (value.kind !== "resource") fail();
  fields(value, ["kind", "owner", "path", "ref", "bytes", "sha256"], ["file_id"]);
  const owner = shortRef(value.owner), resourcePath = path(value.path), ref = reference(value.ref);
  if (!owner.startsWith("sr:S") || ref.path !== resourcePath || !ref.snapshot || ref.fileId !== value.file_id
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || typeof value.sha256 !== "string" || !HASH.test(value.sha256)) fail();
  return Object.freeze({ kind: "resource", owner, path: resourcePath, ref: canonical(ref), bytes: Number(value.bytes), sha256: value.sha256,
    ...(ref.fileId === undefined ? {} : { file_id: ref.fileId }) });
}
function shortRef(value: unknown): SessionShortRef {
  if (typeof value !== "string" || !TOKEN.test(value)) fail();
  // A canonical base64url encoding has zero padding bits in its last character.
  const bytes = Buffer.from(value.slice(4), "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== value.slice(4)) fail();
  return value as SessionShortRef;
}
function targetKey(value: SessionShortRefTarget): string {
  if (value.kind === "resource") return JSON.stringify(["resource", value.owner, value.file_id ?? null, value.file_id === undefined ? value.path : null]);
  return JSON.stringify([value.kind, value.identity, ...(value.kind === "selected" ? [value.snapshot_id] : [])]);
}
function selectedOwner(bindings: ReadonlyMap<SessionShortRef, SessionShortRefTarget>, ref: SessionShortRef): SelectedShortRefTarget {
  const owner = bindings.get(ref);
  if (owner?.kind !== "selected") fail("SHORT_REF_OWNER_MISMATCH");
  return owner;
}
function validateOwner(bindings: ReadonlyMap<SessionShortRef, SessionShortRefTarget>, value: SessionShortRefTarget): void {
  if (value.kind !== "resource") return;
  const owner = selectedOwner(bindings, value.owner), ref = reference(value.ref);
  if (ref.selector !== reference(owner.ref).selector || ref.snapshot !== owner.snapshot_id || value.path === owner.entrypoint
    || value.file_id !== undefined && value.file_id === owner.file_id) fail("SHORT_REF_OWNER_MISMATCH");
}
function add(bindings: Map<SessionShortRef, SessionShortRefTarget>, byTarget: Map<string, SessionShortRef>, value: unknown): SessionShortRefEvent {
  if (!object(value)) fail();
  fields(value, ["version", "ref", "target"]);
  if (value.version !== 1) fail();
  const ref = shortRef(value.ref), normalized = target(value.target);
  const prefix = { candidate: "sr:C", selected: "sr:S", resource: "sr:R" }[normalized.kind];
  if (!ref.startsWith(prefix) || !isDeepStrictEqual(value.target, normalized)) fail();
  validateOwner(bindings, normalized);
  const previous = bindings.get(ref), key = targetKey(normalized);
  if (previous && !isDeepStrictEqual(previous, normalized)) fail("SHORT_REF_CONFLICT");
  const otherRef = byTarget.get(key);
  if (otherRef !== undefined && otherRef !== ref) fail("SHORT_REF_CONFLICT");
  bindings.set(ref, normalized);
  byTarget.set(key, ref);
  return Object.freeze({ version: 1, ref, target: normalized });
}
/** Deterministic replay of getBranch(), never getEntries(). No allocation or I/O. */
export function reduceSessionShortRefs(branch: readonly SessionEntry[]): SessionShortRefState {
  const bindings = new Map<SessionShortRef, SessionShortRefTarget>(), byTarget = new Map<string, SessionShortRef>();
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === SESSION_SHORT_REF_ENTRY) add(bindings, byTarget, entry.data);
  }
  return Object.freeze({ bindings });
}
function bind(state: SessionShortRefState, value: SessionShortRefTarget): ShortRefBindingPlan {
  validateOwner(state.bindings, value);
  const key = targetKey(value), byTarget = new Map<string, SessionShortRef>();
  for (const [ref, previous] of state.bindings) {
    const previousKey = targetKey(previous);
    byTarget.set(previousKey, ref);
    if (previousKey !== key) continue;
    if (!isDeepStrictEqual(previous, value)) fail("SHORT_REF_CONFLICT");
    return Object.freeze({ ref, state });
  }
  // A fresh allocation has no rewindable counter. It is a locator, never an access token.
  const ref = `sr:${{ candidate: "C", selected: "S", resource: "R" }[value.kind]}${randomBytes(16).toString("base64url")}` as SessionShortRef;
  const bindings = new Map(state.bindings);
  const event = add(bindings, byTarget, { version: 1, ref, target: value });
  return Object.freeze({ ref, event, state: Object.freeze({ bindings }) });
}
/** Input must come from the current authorized catalog; no selection or activation occurs. */
export function bindCandidate(state: SessionShortRefState, input: { record: ContentRecord; scope: string }): ShortRefBindingPlan {
  return bind(state, Object.freeze({ kind: "candidate", identity: recordIdentity(input.record, input.scope) }));
}
/** Call only after normal prepare/consume validation. A C is never overwritten by an S. */
export function bindSelected(state: SessionShortRefState, binding: PreparationBinding): ShortRefBindingPlan {
  return bind(state, selected(binding));
}
/**
 * Bind an exact file from an already verified immutable owner manifest. This does not
 * authenticate the source, read a file, or prove delivery. Those stay in consume/read.
 */
export function bindResource(state: SessionShortRefState, ownerRef: string, snapshot: SkillRecord, fileRef: string): ShortRefBindingPlan {
  const ownerToken = shortRef(ownerRef), owner = selectedOwner(state.bindings, ownerToken);
  if (!snapshot.preparationBinding || !snapshot.entryManifest?.manifest_complete
    || snapshot.source !== "notion" || snapshot.sourceScope !== owner.identity.scope || snapshot.id !== owner.identity.id
    || snapshot.kind !== owner.identity.kind || snapshot.entrypoint !== owner.entrypoint || !isDeepStrictEqual(snapshot.locator, owner.identity.locator)
    || snapshot.snapshotId !== owner.snapshot_id || snapshot.versionId !== owner.version_id
    || !isDeepStrictEqual(selected(snapshot.preparationBinding), owner)) fail("SHORT_REF_OWNER_MISMATCH");
  const requested = reference(fileRef);
  if (requested.selector !== reference(owner.ref).selector || requested.snapshot !== owner.snapshot_id) fail("SHORT_REF_OWNER_MISMATCH");
  let resourcePath: string;
  try { resourcePath = nativeResourcePath(requested, snapshot); } catch { return fail("SHORT_REF_OWNER_MISMATCH"); }
  const files = snapshot.entryManifest.files, matches = files.filter(file => file.path === resourcePath);
  if (matches.length !== 1) fail("SHORT_REF_OWNER_MISMATCH");
  const file = matches[0]!, exact = reference(file.ref), binding = snapshot.fileBindings?.find(item => item.path === file.path);
  if (exact.selector !== requested.selector || exact.snapshot !== owner.snapshot_id || exact.path !== path(file.path)
    || exact.fileId !== binding?.file_id || requested.fileId !== exact.fileId
    || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HASH.test(file.sha256)) fail("SHORT_REF_OWNER_MISMATCH");
  if (resourcePath === owner.entrypoint) {
    if (file.sha256 !== owner.body_sha256 || canonical(exact) !== owner.ref) fail("SHORT_REF_OWNER_MISMATCH");
    return Object.freeze({ ref: ownerToken, state });
  }
  return bind(state, target({ kind: "resource", owner: ownerToken, path: file.path, ref: canonical(exact), bytes: file.bytes, sha256: file.sha256,
    ...(exact.fileId === undefined ? {} : { file_id: exact.fileId }) }));
}
/** Resolution returns routing/pinning information only. The caller must reauthorize it. */
export function resolveSessionShortRef(state: SessionShortRefState, input: string, expectedScope: string): ResolvedSessionShortRef {
  const ref = shortRef(input), value = state.bindings.get(ref);
  if (!value) fail("SHORT_REF_UNKNOWN");
  const owner = value.kind === "resource" ? selectedOwner(state.bindings, value.owner) : value;
  if (owner.identity.scope !== expectedScope) fail("SHORT_REF_SCOPE_MISMATCH");
  if (value.kind === "resource") return Object.freeze({ kind: "resource", owner: owner as SelectedShortRefTarget, file: value, canonicalRef: value.ref });
  if (value.kind === "selected") return Object.freeze({ kind: "selected", selection: value, canonicalRef: value.ref });
  return Object.freeze({ kind: "candidate", identity: value.identity, canonicalRef: value.identity.ref });
}
/** Portable evidence contains no session handle and grants no access on another host. */
export function exportSessionShortRef(state: SessionShortRefState, input: string, expectedScope: string) {
  const value = resolveSessionShortRef(state, input, expectedScope);
  if (value.kind === "candidate") fail("SHORT_REF_NOT_PINNED");
  if (value.kind === "selected") return Object.freeze({ version: 1 as const, kind: "fixed_skill_reference" as const,
    owner: value.selection, ref: value.canonicalRef });
  const { owner: _sessionOwner, kind: _kind, ...file } = value.file;
  return Object.freeze({ version: 1 as const, kind: "fixed_skill_reference" as const, owner: value.owner,
    ref: value.canonicalRef, file: Object.freeze(file) });
}
