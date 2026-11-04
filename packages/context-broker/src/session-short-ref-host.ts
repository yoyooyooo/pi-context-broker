import { isDeepStrictEqual } from "node:util";
import { nativeResourcePath, parseNativeReference } from "./native-reference";
import {
  SESSION_SHORT_REF_ENTRY, SESSION_SHORT_REF_PREFIX, bindCandidate, bindSelected, bindResource,
  reduceSessionShortRefs, resolveSessionShortRef, exportSessionShortRef,
  type ResolvedSessionShortRef, type SessionShortRef, type SessionShortRefState, type ShortRefBindingPlan, type ShortRefIdentity,
} from "./session-short-ref";
import type { ContentRecord, ExtensionAPI, ExtensionContext, SkillRecord } from "./types";

export type HostShortRefResolution = ResolvedSessionShortRef & Readonly<{
  shortRef: SessionShortRef;
  /** Use these claims to select a current authorized source, then assert that source. */
  assertion: ShortRefIdentity;
}>;
function fail(code = "SHORT_REF_INVALID"): never {
  throw Object.assign(new Error("Skill short reference cannot be used in this session"), { code });
}
/** Malformed tokens in this namespace also belong to the broker; never fall back to file reads. */
export function isSessionShortRefInput(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(SESSION_SHORT_REF_PREFIX);
}
function branch(ctx: ExtensionContext) {
  const manager = ctx.sessionManager;
  if (!manager?.getBranch) fail("SHORT_REF_SESSION_UNAVAILABLE");
  return { state: reduceSessionShortRefs(manager.getBranch()), id: manager.getSessionId?.(), file: manager.getSessionFile?.() };
}
function sourceRecord(record: SkillRecord): ContentRecord {
  if (record.source !== "notion" || record.locator?.type === "local") fail("SHORT_REF_UNSUPPORTED");
  if (!record.id || !record.kind || !record.locator || !record.entrypoint || !record.ref || !record.alias
    || typeof record.default_context !== "boolean") fail();
  return { id: record.id, kind: record.kind, locator: record.locator, name: record.name, alias: record.alias,
    description: record.description, default_context: record.default_context, entrypoint: record.entrypoint, ref: record.ref,
    ...(record.enabled === undefined ? {} : { enabled: record.enabled }) };
}
function resolved(state: SessionShortRefState, input: string): HostShortRefResolution {
  // Reading the stored scope is routing, not authorization. The caller must match
  // it against the current authorized source and retain the assertion through I/O.
  const stored = state.bindings.get(input as SessionShortRef);
  const owner = stored?.kind === "resource" ? state.bindings.get(stored.owner) : stored;
  const claim = owner && owner.kind !== "resource" ? owner.identity : undefined;
  const value = resolveSessionShortRef(state, input, claim?.scope ?? "");
  if (!claim) fail("SHORT_REF_UNKNOWN");
  return Object.freeze({ ...value, shortRef: input as SessionShortRef, assertion: claim });
}
/** Match full source identity, not just an ambiguous URI selector or a source label. */
export function matchesShortRefSource(assertion: ShortRefIdentity, record: SkillRecord): boolean {
  if (record.source !== assertion.source || !record.sourceId || record.sourceScope !== assertion.scope
    || record.id !== assertion.id || record.kind !== assertion.kind || !isDeepStrictEqual(record.locator, assertion.locator) || !record.ref) return false;
  try { return parseNativeReference(record.ref).selector === parseNativeReference(assertion.ref).selector; }
  catch { return false; }
}
/** Call after normal authorized discovery/lookup. This does not itself renew permission. */
export function assertShortRefSource(value: HostShortRefResolution, record: SkillRecord): void {
  if (record.sourceScope !== value.assertion.scope) fail("SHORT_REF_SCOPE_MISMATCH");
  if (!matchesShortRefSource(value.assertion, record)) fail("SHORT_REF_OWNER_MISMATCH");
}
/** Call after normal prepare/read validation, before any bytes or success receipt are exposed. */
export function assertShortRefSnapshot(value: HostShortRefResolution, snapshot: SkillRecord): void {
  assertShortRefSource(value, snapshot);
  if (value.kind === "candidate") return;
  const expected = value.kind === "selected" ? value.selection : value.owner;
  const binding = snapshot.preparationBinding;
  if (!binding || snapshot.snapshotId !== expected.snapshot_id || snapshot.versionId !== expected.version_id
    || snapshot.entrypoint !== expected.entrypoint || binding.scope !== expected.identity.scope
    || binding.snapshot_id !== expected.snapshot_id || binding.version_id !== expected.version_id || binding.body_sha256 !== expected.body_sha256
    || binding.record.id !== expected.identity.id || binding.record.kind !== expected.identity.kind
    || !isDeepStrictEqual(binding.record.locator, expected.identity.locator)) fail("SHORT_REF_OWNER_MISMATCH");
  try {
    if (!isDeepStrictEqual(parseNativeReference(binding.ref), parseNativeReference(expected.ref))) fail("SHORT_REF_OWNER_MISMATCH");
  } catch { fail("SHORT_REF_OWNER_MISMATCH"); }
  if (value.kind !== "resource") return;
  const manifest = snapshot.entryManifest;
  if (!manifest?.manifest_complete) fail("SHORT_REF_OWNER_MISMATCH");
  let actualPath: string;
  try { actualPath = nativeResourcePath(parseNativeReference(value.canonicalRef), snapshot); }
  catch { return fail("SHORT_REF_OWNER_MISMATCH"); }
  const files = manifest.files.filter(file => file.path === actualPath), expectedFile = value.file;
  if (files.length !== 1 || actualPath !== expectedFile.path || files[0]!.sha256 !== expectedFile.sha256
    || files[0]!.bytes !== expectedFile.bytes) fail("SHORT_REF_OWNER_MISMATCH");
  try {
    if (!isDeepStrictEqual(parseNativeReference(files[0]!.ref), parseNativeReference(expectedFile.ref))) fail("SHORT_REF_OWNER_MISMATCH");
  } catch { fail("SHORT_REF_OWNER_MISMATCH"); }
}

/**
 * A synchronous bridge with no process-local reference cache. Every operation starts
 * from getBranch(); api.appendEntry must make entries visible there before display.
 * The host's existing lifecycle guard still owns cancellation across asynchronous I/O.
 */
export function createSessionShortRefHost(api: ExtensionAPI) {
  function persist(ctx: ExtensionContext, before: ReturnType<typeof branch>, plans: readonly ShortRefBindingPlan[]): SessionShortRef {
    const result = plans.at(-1);
    if (!result) fail();
    const events = plans.flatMap(plan => plan.event ? [plan.event] : []);
    if (events.length && !api.appendEntry) fail("SHORT_REF_SESSION_UNAVAILABLE");
    for (const event of events) {
      try { api.appendEntry!(SESSION_SHORT_REF_ENTRY, event); }
      catch { fail("SHORT_REF_PERSIST_FAILED"); }
    }
    const after = branch(ctx);
    if (before.id !== after.id || before.file !== after.file) fail("SHORT_REF_SESSION_CHANGED");
    for (const [ref, target] of before.state.bindings) {
      if (!isDeepStrictEqual(after.state.bindings.get(ref), target)) fail("SHORT_REF_SESSION_CHANGED");
    }
    // A void append that failed to persist cannot produce a usable advertised handle.
    if (!isDeepStrictEqual(after.state.bindings.get(result.ref), result.state.bindings.get(result.ref))) fail("SHORT_REF_PERSIST_FAILED");
    return result.ref;
  }
  return Object.freeze({
    canBind(ctx: ExtensionContext): boolean { return Boolean(api.appendEntry && ctx.sessionManager?.getBranch); },
    candidate(ctx: ExtensionContext, record: SkillRecord): SessionShortRef {
      const before = branch(ctx);
      const plan = bindCandidate(before.state, { record: sourceRecord(record), scope: record.sourceScope ?? "" });
      return persist(ctx, before, [plan]);
    },
    selected(ctx: ExtensionContext, snapshot: SkillRecord): SessionShortRef {
      const before = branch(ctx);
      if (!snapshot.preparationBinding) fail("SHORT_REF_OWNER_MISMATCH");
      const plan = bindSelected(before.state, snapshot.preparationBinding);
      assertShortRefSnapshot(resolved(plan.state, plan.ref), snapshot);
      return persist(ctx, before, [plan]);
    },
    resource(ctx: ExtensionContext, snapshot: SkillRecord, fileRef: string): SessionShortRef {
      const before = branch(ctx);
      if (!snapshot.preparationBinding) fail("SHORT_REF_OWNER_MISMATCH");
      const owner = bindSelected(before.state, snapshot.preparationBinding);
      const resource = bindResource(owner.state, owner.ref, snapshot, fileRef);
      assertShortRefSnapshot(resolved(resource.state, resource.ref), snapshot);
      // Validate both plans first: an invalid resource must not write its new owner.
      return persist(ctx, before, [owner, resource]);
    },
    resolve(ctx: ExtensionContext, input: string): HostShortRefResolution {
      return resolved(branch(ctx).state, input);
    },
    export(ctx: ExtensionContext, input: string) {
      const state = branch(ctx).state, value = resolved(state, input);
      return exportSessionShortRef(state, input, value.assertion.scope);
    },
  });
}
