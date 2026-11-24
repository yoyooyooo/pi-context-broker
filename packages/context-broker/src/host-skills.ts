import { inheritLibraryContext, libraryContext, type LibrarySelectionOwner } from "./library-selection";
import { resolveNotionLibrarySdk } from "./notion-sdk";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { InvocationError, recordIdentity } from "./discovery-records";
import { assertSourceAvailable, formatSourceFailures, hasEnabledNotionSource } from "./sources";
import { SourceError, SourceReferenceAmbiguity, ReferenceMiss, sourceFailureMessage, sourceFailureDiagnostic } from "./notion-source";
import { createActivationFeedback, ACTIVATION_MESSAGE } from "./activation-feedback";
import { checkPreparationSignal, createPreparationGate, preparationCancelled, type ActivePreparation } from "./skill-preparation";
import type { AgentMessage, ConfigFile, ExtensionAPI, ExtensionContext, ImageContent, SkillRecord, DiscoveryResult, SourceConfig, SourceFailure, NotionListObservation, NotionViewState, ProjectedSessionEntry, ToolCallEvent, ToolCallResult } from "./types";
import type { HostCapabilities } from "./host-adapter";
import { invocationText } from "./invocation-text";
import { viewSystemPrompt, withoutViewMetadata } from "./view-prompt";
import { hostCliScope } from "./host-command";
import { notifyUnavailableReferences, renderUnavailableReferences } from "./unavailable-references";
import { deduplicateSourceReads, deferredSourceEntries, nativeReadReceipt, notionReadStatusFooter, type NotionReadStatus, sourceDeliveryReceipt, sourceMessageText, contextSourceIdentities, inspectedResource, projectSelectedSourceMessages, withSessionSourceReceipts } from "./session-source-snapshot";
import { parseNativeReference, parseNotionReference, notionPageId, nativeResourcePath, nativeFileBinding, relativeReadInput, hasExactNativeOwner, nativeReferenceLibrary, bindNativeReference, formatNativeReference, withNativeSnapshot, type ExactNativeReference } from "./native-reference";
import { preparationFailureDetails, type PreparedHostGraph, type PreparationPurpose, type PreparationBinding, type PreparationDirectory } from "./prepare-protocol";
import { applySelectionGraphs, samePreparationBinding, sessionSelection, selectedTaskRole, type SelectionMode } from "./session-graph";
import { publicEntryMaterialization } from "./notion-entry";
import { createSessionShortRefHost, isSessionShortRefInput, matchesShortRefSource, assertShortRefSource, assertShortRefSnapshot, assertShortRefResource, type HostShortRefResolution } from "./session-short-ref-host";
import { compileSkillPreparation, projectSkillDirectory } from "./skill-context-projection";
import { projectCatalogDescriptions, type CatalogDescription } from "./skill-catalog-projection";
import { reduceSessionShortRefs, resolveSessionShortRef } from "./session-short-ref";
import { compileResourceRead } from "./resource-read-projection";
import { notionReadDisplay, withReadDisplay, type ReadDisplaySnapshot } from "./read-display";
import { normalizeResourceReadBudget, RESOURCE_READ_MAX_CONTEXT_BYTES, type ResourceReadBudget, type FixedResourceRead, type ResourceReadBatch, type ResourceReadFileIdentity } from "./resource-read-types";
import { createConsumerObservations, type ObservationTicket } from "./consumer-observation";
import { notionCatalogAction, notionCatalogRetryGapMs, notionListFreshness } from "./catalog-menu";
import { combineConsumptionEffects, consumptionEffects, errorConsumptionEffects, noConsumptionWrites, type ConsumptionEffects, type ConsumptionPolicy } from "./consumption-effects";
import { createFinalRequestLedger, type FinalRequestLedger } from "./final-request";
import { RECOVERY_NOTICE, assertActiveContextDelivery, type ActiveContextRestoration } from "./session-recovery";
import { activeSources, activeSelection } from "./session-active";
import { assertWorkingSetBudget, exportWorkingSet, releaseWorkingSetRoots, setWorkingSetBudget, WorkingSetBudgetError } from "./session-working-set";
import { CONTENT_SEARCH_MAX_RESULTS, CONTENT_SEARCH_TIMEOUT_MS, contentSearchFailure, type ContentSearchRequest, type ContentSearchOptions, type ContentSearchResult } from "./content-search";
import { createContentPublication } from "./content-publication";

export type HostSkillOptions = {
  config: ConfigFile;
  librarySelection?: LibrarySelectionOwner;
  getRecords(ctx?: ExtensionContext, signal?: AbortSignal, refreshSourceIds?: readonly string[], sourceId?: string): Promise<DiscoveryResult<SkillRecord>>;
  metadataInvalidated?(ctx: ExtensionContext): boolean;
  contentSearch?(input: ContentSearchRequest, sourceId: string, ctx: ExtensionContext, options: ContentSearchOptions): Promise<ContentSearchResult>;
  lookupReference?(ctx: ExtensionContext, signal?: AbortSignal): Promise<DiscoveryResult<SkillRecord>>;
  resolveSkillReference?(ref: string, ctx: ExtensionContext, signal?: AbortSignal, refresh?: boolean, sourceId?: string): Promise<{ record: SkillRecord; ref: string }>;
  resolveRelativeReference?(record: SkillRecord, from: string, path: string, ctx: ExtensionContext, signal: AbortSignal, policy: ConsumptionPolicy): Promise<string>;
  resolveCurrentRoot?(record: SkillRecord, ctx: ExtensionContext, signal: AbortSignal): Promise<{ record: SkillRecord; ref: string }>;
  loadRecord(record: SkillRecord, signal?: AbortSignal, snapshotId?: string, policy?: ConsumptionPolicy): Promise<SkillRecord>;
  loadResource?(record: SkillRecord, path: string, ctx: ExtensionContext, signal?: AbortSignal, policy?: ConsumptionPolicy): Promise<string>;
  readFixedResource?(record: SkillRecord, ref: string, ctx: ExtensionContext, signal?: AbortSignal, policy?: ConsumptionPolicy): Promise<FixedResourceRead | undefined>;
  readResources?(record: SkillRecord, refs: readonly string[], budget: ResourceReadBudget, ctx: ExtensionContext, signal?: AbortSignal, policy?: ConsumptionPolicy): Promise<ResourceReadBatch>;
  prepareGraph?(records: readonly SkillRecord[], ctx: ExtensionContext | undefined, signal: AbortSignal | undefined, purpose: PreparationPurpose, pins?: ReadonlyMap<string, string>, bindings?: readonly PreparationBinding[], mode?: SelectionMode, policy?: ConsumptionPolicy): Promise<PreparedHostGraph[]>;
  persistGraphs?(graphs: readonly PreparedHostGraph[], ctx: ExtensionContext, mode: SelectionMode): void;
  sessionGraph?(ctx: ExtensionContext): unknown;
  projectContext?(messages: AgentMessage[], ctx: ExtensionContext, pending?: readonly { graphs: PreparedHostGraph[]; mode: SelectionMode }[]): AgentMessage[];
  restoreActive?(messages: AgentMessage[], ctx: ExtensionContext, signal: AbortSignal, pending: readonly { graphs: PreparedHostGraph[]; mode: SelectionMode }[]): Promise<ActiveContextRestoration>;
  confirmDelivery?(records: readonly SkillRecord[], messages: AgentMessage[], ctx: ExtensionContext): void;
  needsPreflightPrompt?(text: string): boolean;
  onPreparation?(entry: ActivePreparation): void;
  preflightPrompt?(text: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<void>;
  taskPrompt?(text: string, ctx: ExtensionContext, signal?: AbortSignal, invocation?: ActivePreparation): Promise<string>;
  /** Pi acquires only after the host has created its cancellable agent operation. */
  buildPreparedPrompt?(text: string, ctx: ExtensionContext, signal: AbortSignal, prepared: readonly SkillRecord[]): Promise<Omit<AgentMessage, "role" | "timestamp"> | undefined>;
  isLoaded?(record: SkillRecord, ctx: ExtensionContext): boolean;
  sessionSnapshot?(record: SkillRecord, ctx: ExtensionContext): string | undefined;
  sessionBinding?(record: SkillRecord, ctx: ExtensionContext): PreparationBinding | undefined;
  onMetadata?(records: SkillRecord[]): void;
  /** Shared with `/context-broker request`. Omitted installs a private ledger. */
  finalRequests?: FinalRequestLedger;
};
export type PreparedReference = { status: "ready"; record: SkillRecord } | { status: "miss" };
export type HostSkills = {
  invalidate(): void;
  turnContext(ctx: ExtensionContext): ExtensionContext;
  refresh(ctx?: ExtensionContext, options?: { preserveTurn?: boolean }): Promise<void>;
  activate(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal): Promise<SkillRecord>;
  prepare(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal): Promise<PreparedReference>;
  prepareMany(records: readonly SkillRecord[], ctx?: ExtensionContext, signal?: AbortSignal): Promise<void>;
  withPreparedPrompt<T>(prompt: string, ctx: ExtensionContext, build: (signal?: AbortSignal, native?: SkillRecord, original?: string, prepared?: readonly SkillRecord[]) => Promise<T>): Promise<T>;
  isNativeLoaded(messages: AgentMessage[], record: SkillRecord): boolean;
  selectedModelReference(record: SkillRecord, ctx: ExtensionContext): string | undefined;
  selectedModelFiles(record: SkillRecord, ctx: ExtensionContext): PreparationDirectory["files"] | undefined;
  viewStatus(): readonly NotionViewState[];
  assertCanRestore(record: SkillRecord): void;
  withFixedRestoration<T>(records: readonly SkillRecord[], signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T>;
};

export function hostSkillName(record: SkillRecord): string {
  return (record.token ?? record.name).replace(/[^a-z0-9-]/g, "-");
}
function failure(error: unknown): string {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  if (error instanceof SourceReferenceAmbiguity) return error.message;
  if (error instanceof SourceError && error.code === "CONTENT_DISABLED")
    return `context-broker Skill disabled (CONTENT_DISABLED). ${sourceFailureMessage(error.code)}`;
  if (error instanceof SourceError && error.code === "SHARED_ROUTER_MEMBER_UNAVAILABLE")
    return `context-broker preparation incomplete (${error.code}). ${sourceFailureMessage(error.code, error.details)}`;
  if (error instanceof SourceError) return `context-broker source ${error.sourceId} unavailable (${error.code}). ${sourceFailureMessage(error.code, error.details)}`;
  if (error instanceof InvocationError) return error.message;
  return `context-broker activation failed (${typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "SOURCE_ACTIVATION_FAILED"})`;
}
function hostError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
function consumptionFailure(error: unknown, message: string, effects: ConsumptionEffects): Error {
  // Transport errors may expose getter-only fields; shared errors may be frozen.
  const wrapped = error instanceof SourceReferenceAmbiguity
    ? new SourceReferenceAmbiguity(error.sourceId, error.candidates, message)
    : error instanceof SourceError ? new SourceError(error.code, error.sourceId, error.exitCode) : new Error(message);
  Object.defineProperty(wrapped, "cause", { value: error, configurable: true, writable: true });
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  return Object.assign(wrapped, {
    message, ...(error instanceof Error ? { name: error.name } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    details: { ...(error instanceof SourceError ? error.details : error !== null && typeof error === "object" && "details" in error ? preparationFailureDetails(error.details) : {}), effects },
  });
}
function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function expandPath(path: string, cwd?: string): string {
  return resolve(cwd ?? process.cwd(), path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

async function canonicalEntryPath(path: string, roots: ReadonlySet<string>, signal: AbortSignal): Promise<string> {
  checkPreparationSignal(signal);
  if (!roots.size || [...roots].some(root => path.startsWith(root + sep))) return path;
  // Resolve aliases above the verified tree, retaining every spelling below it.
  // Resolving the whole file would hide an internal symlink and cannot handle a
  // resource whose declared parent/file has not been materialized yet.
  for (let ancestor = path; ; ancestor = dirname(ancestor)) {
    checkPreparationSignal(signal);
    let actual: string | undefined;
    try { actual = await realpath(ancestor); } catch { /* Probe the next existing ancestor; an unmatched ordinary read stays native. */ }
    checkPreparationSignal(signal);
    if (actual && roots.has(actual)) return actual + path.slice(ancestor.length);
    if (dirname(ancestor) === ancestor) return path;
  }
}

async function assertEntryFilePath(record: SkillRecord, path: string | undefined, signal: AbortSignal): Promise<void> {
  const manifest = record.entryManifest;
  if (!manifest) return;
  const file = manifest.files.find(file => file.path === path);
  if (!file) throw hostError("FILE_NOT_FOUND");
  const parts = file.path.split("/");
  let cursor = manifest.root;
  for (let index = 0; index <= parts.length; index++) {
    checkPreparationSignal(signal);
    if (index) cursor = join(cursor, parts[index - 1]!);
    let metadata;
    try { metadata = await lstat(cursor); }
    catch (error) {
      if (index > 0 && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink() || (index < parts.length ? !metadata.isDirectory() : !metadata.isFile())) throw hostError("SOURCE_CACHE_UNSAFE");
  }
}
type ActivationOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type ReadAdmissionStage = "metadata" | "reference" | "preparation" | "resource" | "path_validation" | "admission";
type ReadAdmission = {
  version: 1; phase: "hook" | "execute"; stage: ReadAdmissionStage; code: string;
  generation_started: number; generation_current: number; signal_aborted: boolean;
};
type PreparedReadResult = ToolCallResult & { assertCurrent?: () => void; effects?: ConsumptionEffects; admission?: ReadAdmission; display?: ReadDisplaySnapshot };
type ResolvedHostReference = { reference: ExactNativeReference; canonicalRef: string; short?: HostShortRefResolution; record?: SkillRecord };
type PendingResourceRead = {
  generation: number;
  display?: ReadDisplaySnapshot;
  purpose?: "inspect";
  effects?: ConsumptionEffects;
  assertCurrent?: () => void;
  selection: { owner: SkillRecord["id"]; scope: SkillRecord["sourceScope"]; snapshot_id: SkillRecord["snapshotId"]; version_id: SkillRecord["versionId"] };
  file: Pick<ResourceReadFileIdentity, "ref" | "path" | "file_id" | "bytes" | "sha256">;
  materialization?: ReturnType<typeof publicEntryMaterialization>;
};
async function headlessActivation<T>(start: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  let timer: NodeJS.Timeout | undefined;
  const outcome = new Promise<ActivationOutcome<T>>((settle) => {
    timer = setTimeout(() => {
      controller.abort();
      settle({ ok: false, error: hostError("SOURCE_ACTIVATION_TIMEOUT") });
    }, timeoutMs);
    Promise.resolve().then(() => start(controller.signal)).then(
      value => settle({ ok: true, value }),
      error => settle({ ok: false, error }),
    );
  });
  const result = await outcome;
  clearTimeout(timer);
  parent?.removeEventListener("abort", abort);
  checkPreparationSignal(parent);
  if (!result.ok) throw result.error;
  return result.value;
}

export async function installHostSkills(api: ExtensionAPI, options: HostSkillOptions, adapter: HostCapabilities): Promise<HostSkills> {
  const ownsFinalRequests = options.finalRequests === undefined;
  const finalRequests = options.finalRequests ?? createFinalRequestLedger();
  const host = api;
  const piConsumption = adapter.paths.host === "pi";
  const sourceToolsEnabled = !piConsumption || hasEnabledNotionSource(options.config);
  const listToolName = piConsumption ? "notion_list" : "skill_search";
  const useToolName = piConsumption ? "notion_use" : "skill_prepare";
  const controlToolName = piConsumption ? "notion_ctl" : "skill_graph";
  const deferredPiDiscovery = adapter.paths.host === "pi" && adapter.metadataDiscovery === "deferred";
  const shortRefs = createSessionShortRefHost(api);
  function modelReference(record: SkillRecord, ctx: ExtensionContext, fixed = false): string | undefined {
    if (adapter.paths.host !== "pi" || record.source !== "notion" || !shortRefs.canBind(ctx)) return undefined;
    return fixed && record.preparationBinding ? shortRefs.selected(ctx, record) : shortRefs.candidate(ctx, record);
  }
  function modelCandidateReferences(values: readonly SkillRecord[], ctx: ExtensionContext): ReadonlyMap<SkillRecord, string> {
    if (adapter.paths.host !== "pi" || !shortRefs.canBind(ctx)) return new Map();
    const candidates = values.filter(record => record.source === "notion");
    if (!candidates.length) return new Map();
    const refs = shortRefs.candidates(ctx, candidates);
    return new Map(candidates.map((record, index) => [record, refs[index]!]));
  }
  function resolveReference(value: string, ctx: ExtensionContext): { reference: ExactNativeReference; short?: HostShortRefResolution } {
    if (!isSessionShortRefInput(value)) return { reference: parseNotionReference(value) };
    const short = shortRefs.resolve(ctx, value);
    return { reference: parseNativeReference(short.canonicalRef), short };
  }
  async function resolveToolReference(value: string, ctx: ExtensionContext, signal: AbortSignal, refresh?: boolean): Promise<ResolvedHostReference> {
    const resolved = resolveReference(value, ctx), requested = resolved.reference;
    const physicalPage = notionPageId(requested.selector);
    const canonical = hasExactNativeOwner(requested);
    if (resolved.short || canonical || !physicalPage && !options.resolveSkillReference)
      return { ...resolved, canonicalRef: resolved.short?.canonicalRef ?? value };
    if (!options.resolveSkillReference) throw hostError("SOURCE_REFERENCE_MISSING");
    const observedGeneration = generation, sessionId = ctx.sessionManager?.getSessionId?.(), sessionFile = ctx.sessionManager?.getSessionFile?.();
    const current = () => {
      checkPreparationSignal(signal);
      if (observedGeneration !== generation || sessionId !== ctx.sessionManager?.getSessionId?.() || sessionFile !== ctx.sessionManager?.getSessionFile?.()) throw preparationCancelled();
    };
    const checked = (selected: { record: SkillRecord; ref: string }) => {
      const reference = parseNativeReference(selected.ref), record = selected.record;
      if (record.source !== "notion" || !record.sourceId || !record.sourceScope || !record.ref || record.enabled === false
        || reference.selector !== parseNativeReference(record.ref).selector || reference.snapshot !== requested.snapshot
        || reference.path !== (requested.path || record.entrypoint)
        || physicalPage === undefined && (record.locator?.type !== "shared_skill"
          || bindNativeReference(requested, record.locator.library_id).selector !== record.id)
        || physicalPage !== undefined && (record.locator?.type !== "shared_skill" || notionPageId(record.locator.page_id) !== physicalPage))
        throw hostError("SOURCE_IDENTITY_MISMATCH");
      const exact = requested.path ? reference : { ...reference, path: "" };
      return { reference: exact, canonicalRef: formatNativeReference(exact), record };
    };
    let selected: { record: SkillRecord; ref: string };
    try { selected = await options.resolveSkillReference(value, ctx, signal, refresh); }
    catch (error) {
      current();
      if (!(error instanceof SourceReferenceAmbiguity)) throw error;
      if (error.candidates.length < 2) throw hostError("SOURCE_IDENTITY_MISMATCH");
      const candidates = error.candidates.map(checked);
      // Candidate handles bind only unfixed main entries. A manifest-only
      // fixed lookup cannot manufacture the preparation proof for sr:S/R.
      const refs = modelCandidateReferences(candidates.filter(candidate => !candidate.reference.snapshot
        && candidate.reference.path === candidate.record.entrypoint).map(candidate => candidate.record), ctx);
      const choices = candidates.map(candidate => ({ name: candidate.record.name, source: candidate.record.sourceId!,
        ref: refs.get(candidate.record) ?? candidate.canonicalRef }));
      const presented = choices.map(choice => ({ ...choice, selectable: choices.filter(other => other.ref === choice.ref).length === 1 }));
      current();
      for (const candidate of candidates) hostRecords.set(recordIdentity(candidate.record), candidate.record);
      throw new SourceReferenceAmbiguity(error.sourceId, error.candidates, JSON.stringify({ code: error.code,
        message: "Multiple Notion Skills match. Copy one selectable ref into the same read or notion_use call. These are metadata choices, not loaded content. A non-selectable ref cannot distinguish source scopes here; keep its snapshot and do not substitute current.",
        candidates: presented }));
    }
    current();
    return checked(selected);
  }
  function assertRefreshMain(reference: ExactNativeReference, record: SkillRecord, ctx: ExtensionContext, short?: HostShortRefResolution): void {
    let main = short?.kind === "selected" ? short.selection.entrypoint : record.entrypoint;
    if (reference.snapshot !== undefined && short?.kind !== "selected") {
      const binding = options.sessionBinding?.(record, ctx);
      if (binding && binding.scope === record.sourceScope && binding.record.id === record.id
        && binding.snapshot_id === reference.snapshot) main = binding.record.entrypoint;
    }
    if (short?.kind === "resource" || record.kind === "prompt" || reference.path && reference.path !== main)
      throw hostError("PREPARE_ROOT_NOT_MAIN");
  }
  function assertRefreshRootRoles(references: readonly { reference: ExactNativeReference; short?: HostShortRefResolution; record?: SkillRecord }[], ctx: ExtensionContext): void {
    let selection = sessionSelection(ctx);
    for (const transition of gate.active ? pendingGraphs.get(gate.active) ?? [] : [])
      selection = applySelectionGraphs(selection, { graphs: transition.graphs.map(graph => graph.lock), mode: transition.mode, selectionId: "pending-preparation" });
    const identity = libraryContext(ctx)?.local();
    const enabledSources = identity?.sources ?? options.config.sources?.filter((source): source is Extract<SourceConfig, { type: "notion" }> => source.type === "notion" && source.enabled !== false) ?? [];
    const bindings = [...selection.scopes.values()].flatMap(scope => [...scope.bindings.values()]);
    const requiredOnly = new Map<string, { scope: string; id: string; ref: string; required_by: readonly string[] }>();
    for (const { reference, short, record } of references) {
      const owners = hasExactNativeOwner(reference)
        ? enabledSources.filter(source => source.library === nativeReferenceLibrary(reference))
        : identity ? [identity.source] : enabledSources;
      const currentScopes = new Set(owners.map(source => catalogScopes.get(JSON.stringify([source.id, source.library]))).filter(Boolean));
      const candidates = bindings.filter(binding => {
        if (!short && !record && (owners.length !== 1 || currentScopes.size !== 1 || !currentScopes.has(binding.scope))) return false;
        const main = parseNativeReference(binding.ref);
        if (main.selector !== reference.selector || reference.path && reference.path !== binding.record.entrypoint
          || reference.snapshot && reference.snapshot !== binding.snapshot_id) return false;
        if (short && (short.assertion.scope !== binding.scope || short.assertion.id !== binding.record.id
          || short.assertion.kind !== binding.record.kind || !isDeepStrictEqual(short.assertion.locator, binding.record.locator))) return false;
        if (record && (record.sourceScope !== binding.scope || record.id !== binding.record.id
          || record.kind !== binding.record.kind || !isDeepStrictEqual(record.locator, binding.record.locator))) return false;
        return true;
      });
      // An unscoped or ambiguous selector cannot acquire a role from another source.
      if (candidates.length !== 1) continue;
      const binding = candidates[0]!, role = selectedTaskRole(selection, binding);
      if (!role || role.roles.some(value => value === "root") || !role.required_by) continue;
      requiredOnly.set(JSON.stringify([binding.scope, binding.record.id]), {
        scope: binding.scope, id: binding.record.id, ref: binding.ref, required_by: role.required_by,
      });
    }
    if (!requiredOnly.size) return;
    const scopes = new Set([...requiredOnly.values()].map(binding => binding.scope));
    const roots = [...selection.scopes.values()].filter(scope => scopes.has(scope.scope)).flatMap(scope =>
      [...scope.roots].flatMap(id => {
        const binding = scope.bindings.get(id), role = binding && selectedTaskRole(selection, binding);
        return binding && role?.roles.some(value => value === "root") ? [{ scope: scope.scope, id, ref: binding.ref }] : [];
      }));
    const diagnostic = {
      code: "ROOT_ROLE_CONFLICT", roots: roots.slice(0, 64),
      ...(roots.length > 64 ? { roots_truncated: true } : {}),
      required_only: [...requiredOnly.values()].map(value => ({ ...value, required_by: value.required_by.slice(0, 64),
        ...(value.required_by.length > 64 ? { required_by_truncated: true } : {}) })),
      next: "refresh_task_roots_or_explicit_use",
    };
    const effects = noConsumptionWrites();
    // This role error is local and recoverable. It neither grants availability
    // nor converts other early reference failures into acquisition diagnoses.
    throw Object.assign(new Error(JSON.stringify({ ok: false, status: "failed",
      error: "Refresh cannot promote an existing Requires-only Skill to an independent task root. Requires load automatically. Refresh the current task roots. Only if the user independently requests that Skill as a root, use it without refresh first. Existing selections are unchanged.",
      effects, diagnostic })), { code: diagnostic.code, details: { ...diagnostic, effects } });
  }
  async function currentRoot(record: SkillRecord, ctx: ExtensionContext, signal: AbortSignal): Promise<ResolvedHostReference & { record: SkillRecord }> {
    const observedGeneration = generation, sessionId = ctx.sessionManager?.getSessionId?.(), sessionFile = ctx.sessionManager?.getSessionFile?.();
    const ticket = observations.begin(signal);
    const current = () => {
      checkPreparationSignal(signal);
      if (observedGeneration !== generation || sessionId !== ctx.sessionManager?.getSessionId?.() || sessionFile !== ctx.sessionManager?.getSessionFile?.()) throw preparationCancelled();
    };
    if (!options.resolveCurrentRoot || record.source !== "notion" || record.kind === "prompt") throw hostError("PREPARE_ROOT_NOT_MAIN");
    let selected: { record: SkillRecord; ref: string };
    try { selected = await options.resolveCurrentRoot(record, ctx, signal); }
    catch (error) { current(); observeFailure(error, ticket, [record], undefined, ctx); throw error; }
    current();
    const next = selected.record, reference = parseNativeReference(selected.ref);
    if (next.source !== "notion" || next.sourceId !== record.sourceId || next.sourceScope !== record.sourceScope || next.id !== record.id
      || next.kind !== record.kind || !isDeepStrictEqual(next.locator, record.locator) || !next.ref || reference.snapshot !== undefined
      || reference.selector !== parseNativeReference(next.ref).selector || reference.path !== next.entrypoint)
      throw hostError("SOURCE_IDENTITY_MISMATCH");
    assertRecordSourceAvailable(next);
    return { record: next, reference, canonicalRef: selected.ref };
  }
  let records: SkillRecord[] = [];
  let defaultRouters: SkillRecord[] = [];
  let views: NotionViewState[] = [];
  let generation = 0;
  let metadataGeneration = 0;
  let metadataController = new AbortController();
  let metadataReadiness: Promise<void> = Promise.resolve();
  let metadataPending = false;
  let metadataRefreshSources: ReadonlySet<string> = new Set();
  let lifecycleController = new AbortController();
  let discoveryError: unknown;
  let sourceFailures: SourceFailure[] = [];
  let catalogCoverage = new Map<string, boolean>();
  let metadataFallback = false;
  let filesystemCache: string | undefined;
  const hostRecords = new Map<string, SkillRecord>();
  const observations = createConsumerObservations(() => generation);
  const available = (record: SkillRecord) => observations.state(record) === "available";
  let metadataLists: NonNullable<DiscoveryResult["lists"]> = [];
  let metadataLibraryKey: string | undefined;
  let metadataSourceLibraries = new Map<string, string | undefined>();
  const catalogScopes = new Map<string, string>();
  let metadataRetryAt = 0;
  let catalogPublication: Promise<void> = Promise.resolve();
  const nativeNames = new Map<string, SkillRecord>();
  const readRecords = new Map<string, SkillRecord>();
  const loaded = new Map<string, { record: SkillRecord; owner?: ActivePreparation }>();
  const loading = new Map<string, { operation: Promise<ActivationOutcome<SkillRecord>>; signal?: AbortSignal }>();
  const publishing = new Map<string, Promise<void>>();
  const registeredCommands = new Set<string>();
  const nativeInputs = new Map<string, SkillRecord>();
  const pendingNativeReads = new Map<string, { record: SkillRecord; generation: number; signal: AbortSignal; effects?: ConsumptionEffects; purpose?: "inspect"; display?: ReadDisplaySnapshot }>();
  const pendingResourceReads = new Map<string, PendingResourceRead>();
  const printTurns = new Set<() => void>();
  const gate = createPreparationGate();
  const commandPreparations = new WeakSet<ActivePreparation>();
  const misses = new WeakMap<ActivePreparation, Set<string>>();
  const preparedForUse = new WeakMap<ActivePreparation, Set<string>>();
  const graphSelectionCommits = new WeakMap<SkillRecord, () => void>();
  function beginPreparation(event: { text?: string; images?: ImageContent[] }, ctx: ExtensionContext): ActivePreparation {
    if (options.librarySelection && !libraryContext(ctx)) ctx = options.librarySelection.accept(ctx);
    const entry = gate.begin(event, ctx);
    try { options.onPreparation?.(entry); return entry; }
    catch (error) { gate.release(entry); throw error; }
  }
  let turnPrompts: { snapshots: Map<string, SkillRecord>; signal: AbortSignal } | undefined;
  const feedback = await createActivationFeedback(api, gate.repaint, deferredPiDiscovery ? "widget" : "message");
  let handoff: { entry: ActivePreparation; prompts: string[]; consumed: boolean; selectedNative?: SkillRecord; native?: { snapshot: SkillRecord; promptSha256: string } } | undefined;
  type PiRun = {
    generation: number; sessionId: string | undefined; signal: AbortSignal; entry?: ActivePreparation;
    selectedNative?: SkillRecord; projection?: AgentMessage[];
    prepared: boolean; requestPending: boolean; confirmed: boolean; persisted: number;
    wireBlock?: boolean;
    userEntryId?: string;
    requestProjection?: { count: number; messages: AgentMessage[] };
    confirmedProjection?: { count: number; messages: AgentMessage[] };
    pendingPersistence?: { count: number; nativePromptSha256: string };
    candidates: Map<string, SkillRecord>; graphs: Array<{ graphs: PreparedHostGraph[]; mode: SelectionMode }>;
    contextMessages?: AgentMessage[];
    finalMessages?: AgentMessage[];
  };
  let piRun: PiRun | undefined;
  const pendingGraphs = new WeakMap<ActivePreparation, Array<{ graphs: PreparedHostGraph[]; mode: SelectionMode }>>();
  function assertPiRun(run: PiRun, ctx: ExtensionContext): void {
    checkPreparationSignal(run.signal);
    checkPreparationSignal(run.entry?.controller.signal);
    if (piRun !== run || generation !== run.generation || run.sessionId !== ctx.sessionManager?.getSessionId?.()) throw preparationCancelled();
  }
  function acknowledgeProjection(run: PiRun, entries: readonly ProjectedSessionEntry[]): void {
    const pending = run.pendingPersistence;
    if (!pending) return;
    // A later boundary handler may replace/discard the returned drafts. Advance
    // only after Pi's public projection shows the actual committed receipt.
    const user = entries.find(entry => entry.sourceEntry.id === run.userEntryId)?.messages.find(message => message.role === "user");
    const matches = user && createHash("sha256").update(sourceMessageText(user.content)).digest("hex") === pending.nativePromptSha256;
    if (matches && entries.some(({ sourceEntry: entry }) => entry.type === "custom" && entry.customType === "context-broker"
      && entry.data && typeof entry.data === "object" && "nativePromptSha256" in entry.data
      && entry.data.nativePromptSha256 === pending.nativePromptSha256)) run.persisted = pending.count;
    run.pendingPersistence = undefined;
  }
  const nativeCommands = new Map<string, (args: string, ctx: ExtensionContext, images?: ImageContent[], entry?: ActivePreparation) => Promise<void>>();
  host.on("agent_end", () => {
    acceptedContext = undefined;
    runningContext = undefined;
    if (piRun?.entry) gate.release(piRun.entry);
    if (deferredPiDiscovery && handoff?.entry === piRun?.entry) handoff = undefined;
    piRun = undefined;
    turnPrompts = undefined;
    pendingNativeReads.clear();
    pendingResourceReads.clear();
    for (const complete of printTurns) complete();
    printTurns.clear();
  });

  let acceptedContext: ExtensionContext | undefined;
  let runningContext: ExtensionContext | undefined;
  const turnContext = (ctx: ExtensionContext) => inheritLibraryContext(ctx, runningContext ?? gate.active?.ctx ?? acceptedContext);
  const visibleInLibrary = (record: SkillRecord, ctx: ExtensionContext) => !options.librarySelection || record.source !== "notion"
    || record.sourceId === libraryContext(ctx)?.local()?.source.id && record.locator?.type === "shared_skill"
      && record.locator.library_id === libraryContext(ctx)?.local()?.root;
  async function ready(signal: AbortSignal = lifecycleController.signal): Promise<void> {
    checkPreparationSignal(signal);
    const cancelled = Promise.withResolvers<never>();
    const abort = () => cancelled.reject(preparationCancelled());
    signal.addEventListener("abort", abort, { once: true });
    try {
      // A forced metadata request can supersede a pending cached acquisition.
      // Every waiter follows the selected publication, never the retired result.
      for (;;) {
        const pending = metadataReadiness;
        const owner = metadataController.signal;
        const superseded = Promise.withResolvers<void>();
        const wake = () => superseded.resolve();
        owner.addEventListener("abort", wake, { once: true });
        if (owner.aborted) wake();
        try { await Promise.race([pending, cancelled.promise, superseded.promise]); }
        finally { owner.removeEventListener("abort", wake); }
        checkPreparationSignal(signal);
        if (pending === metadataReadiness) break;
      }
    } finally { signal.removeEventListener("abort", abort); }
  }

  function revalidateMetadata(ctx: ExtensionContext, refreshSourceIds?: readonly string[]): Promise<void> {
    if (options.librarySelection && !options.librarySelection.isCurrent(ctx)) return metadataReadiness;
    if (refreshSourceIds?.length) {
      if (metadataPending && refreshSourceIds.every(id => metadataRefreshSources.has(id))) return metadataReadiness;
      const requested = [...new Set([...(metadataPending ? metadataRefreshSources : []), ...refreshSourceIds])];
      metadataReadiness = refreshMetadata(ctx, false, true, requested);
      return metadataReadiness;
    }
    if (metadataPending) return metadataReadiness;
    const currentLibrary = libraryContext(ctx)?.local();
    const sourceIds = (options.librarySelection ? currentLibrary ? [currentLibrary.source] : [] : options.config.sources ?? []).filter(source => source.type === "notion" && source.enabled !== false
      && !source.discovery?.offline).map(source => source.id);
    const expired = notionCatalogAction({ offline: false, sourceIds, observations: metadataLists,
      failedSourceIds: sourceFailures.map(failure => failure.sourceId), now: Date.now(), retryAt: metadataRetryAt });
    // A legacy metadata producer without freshness cannot acquire freshness by
    // being read again. Its explicit refresh route remains available.
    if (options.librarySelection && options.librarySelection.key(ctx) !== metadataLibraryKey
      || options.metadataInvalidated?.(ctx) || metadataLists.some(list => list.validatedAt !== undefined) && expired === "refresh") {
      metadataReadiness = refreshMetadata(ctx, false, true);
    }
    return metadataReadiness;
  }

  async function searchContent(input: Record<string, unknown>, ctx: ExtensionContext, readSignal: AbortSignal) {
    if (typeof input.query !== "string" || !input.query.trim()
      || input.cursor !== undefined || Number(input.limit ?? 20) > CONTENT_SEARCH_MAX_RESULTS) throw hostError("INVALID_ARGUMENT");
    const enabledSources = () => (options.config.sources ?? []).filter(source => source.type === "notion" && source.enabled !== false);
    const selectedLibrary = await options.librarySelection?.selected(ctx);
    const sources = selectedLibrary?.sources ?? enabledSources();
    if (input.source === undefined && !selectedLibrary && sources.length !== 1)
      throw Object.assign(new Error("Choose one configured Notion source for content search."), { code: "CONTENT_SOURCE_REQUIRED" });
    const sourceId = typeof input.source === "string" ? input.source : selectedLibrary?.source.id ?? sources[0]?.id;
    const source = sources.find(value => value.id === sourceId);
    if (!source || source.type !== "notion") throw hostError("SOURCE_UNAVAILABLE");
    if (!source.library?.trim())
      throw Object.assign(new Error("Content search requires a verified Library root for the selected Source."), { code: "CONTENT_SOURCE_REQUIRED" });
    if (source.discovery?.offline) throw hostError("CONTENT_SEARCH_OFFLINE");
    const requestedConfiguration = JSON.stringify(source);
    const deadline = Date.now() + CONTENT_SEARCH_TIMEOUT_MS;
    const signal = AbortSignal.any([readSignal, ...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(CONTENT_SEARCH_TIMEOUT_MS)]);
    revalidateMetadata(ctx, input.refresh === true ? [source.id] : undefined);
    await ready(signal);
    const sourceConfiguration = () => {
      const current = (selectedLibrary?.sources ?? enabledSources()).find(value => value.id === source.id);
      return current && !options.metadataInvalidated?.(ctx) ? JSON.stringify(current) : undefined;
    };
    if (sourceConfiguration() !== requestedConfiguration) throw preparationCancelled();
    const publication = createContentPublication({
      ctx, deadline, signal: AbortSignal.any([signal, metadataController.signal]),
      current: () => ({ task: generation, metadata: metadataGeneration, qualification: observations.revision(), source: sourceConfiguration() }),
      onQualificationChange: observations.onChange,
    });
    try {
      publication.assertCurrent();
      if (!options.contentSearch) throw hostError("SOURCE_SDK_INCOMPATIBLE");
      // Preserve case, Unicode and whitespace. Authorization resumes this exact
      // request, and neither the host nor the SDK broadens its selected source.
      const request = { query: input.query, limit: Number(input.limit ?? 20) };
      const present = adapter.presentAuthorization;
      // Absence of a callback tells the SDK not to create an OAuth flight or
      // listener. A cached credential may still serve a noninteractive search.
      const onAuthorize: ContentSearchOptions["onAuthorize"] = present && ctx.hasUI && ctx.mode === "tui" && ctx.ui?.custom
        ? async request => {
          publication.assertCurrent();
          await present({ ...request, signal: AbortSignal.any([request.signal, publication.signal]),
            deadline: Math.min(request.deadline, deadline) }, ctx);
          publication.assertCurrent();
        } : undefined;
      const result = await publication.wait(signal => options.contentSearch!(request, source.id, ctx, {
        signal, deadline, ...(onAuthorize ? { onAuthorize } : {}),
      }));
      publication.assertCurrent();
      const output = { ok: true, state: "known", search_in: "content", source: source.id, count: result.records.length,
        next_cursor: null, pagination: "not_supported", coverage: result.coverage, exhaustive: false, partial: result.partial,
        result_id: result.resultId, connection: result.connection,
        records: result.records.map(record => ({ ...record, source: source.id, availability: "available" })), notices: result.notices,
        match_semantics: "Notion remote matches may include titles or stored projections. They do not prove exact fixed Skill or resource bytes match, and no result does not establish absence." };
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
    } catch (error) {
      // This guard also covers empty/error/denial responses. Retired requests
      // expose only a local cancellation, never the remote diagnostic.
      publication.assertCurrent();
      const output = contentSearchFailure(error);
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
    } finally { publication.close(); }
  }

  if (sourceToolsEnabled) host.registerTool?.({
    name: listToolName, label: piConsumption ? "List Notion Skills" : "Skill search",
    description: `Search the authorized Skill metadata directory, including items outside the default View. Returns ${piConsumption ? "Skill refs for read or notion_use" : "exact read references only"}; it does not load instructions or activate workflows.${piConsumption ? " For named Notion Skill existence or availability questions, set query to the name and refresh:true, even when already listed or previously absent. Answer existence and stated-purpose questions from metadata; read or use the Skill only when the user asks to inspect or apply its instructions. Also refresh after writes or to request the latest directory; selected Skill versions stay fixed. Report matching availability. Only fresh online results with exhaustive coverage and no failures establish that no available match was found in the searched scope; stale, offline, failed or partial results cannot establish current absence. Use search_in:content only when the user asks to search Skill content. Content mode requires a nonempty query and one configured source, performs an authorized remote Notion search, and may request foreground OAuth. Content results are always non-exhaustive and do not prove exact fixed Skill or supporting-file bytes match. Content mode has no cursor; limit is at most 50. It never adopts or changes task instructions." : ""}`,
    parameters: { type: "object", properties: {
      query: { type: "string", description: piConsumption ? "A short name or description keyword; empty lists the metadata directory. Content search requires a nonempty user-requested query." : "A short name or description keyword; empty lists the directory." },
      source: { type: "string", description: piConsumption ? "Configured source ID. Omission uses this accepted turn's selected Library for metadata and content search." : "Optional configured source ID to disambiguate directories." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: piConsumption ? "Maximum entries, default 20. Content search accepts at most 50 and has no pagination." : "Maximum metadata entries, default 20." },
      ...(piConsumption ? {
        search_in: { type: "string", enum: ["metadata", "content"], description: "Default metadata searches names and descriptions without MCP or authorization UI. Content explicitly searches remote Notion content in one configured source." },
        refresh: { type: "boolean", description: "Refresh metadata for the explicit source, or this accepted turn's selected Library when source is omitted. Keeps task pins; configured offline sources remain offline. Does not refresh the remote full-text index. Cannot combine with cursor." },
        cursor: { type: "string", description: "Metadata only: copy next_cursor to continue the same query and metadata publication; restart after refresh. Content mode rejects all cursors." },
      } : {}),
    }, required: piConsumption ? [] : ["query"], additionalProperties: false },
    strict: true, readsSkillUris: false, loadMode: "essential",
    approval: () => "read", approvalCacheTargets: () => undefined,
    sourcePath: import.meta.url, defaultInactive: false,
    async execute(_id, input, signal, _onUpdate, ctx) {
      ctx = turnContext(ctx);
      const readSignal = signal ? AbortSignal.any([signal, lifecycleController.signal]) : lifecycleController.signal;
      checkPreparationSignal(readSignal);
      if ((input.query !== undefined || !piConsumption) && (typeof input.query !== "string" || input.query.length > 512)
        || input.source !== undefined && typeof input.source !== "string"
        || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)
        || input.cursor !== undefined && (typeof input.cursor !== "string" || !piConsumption)
        || input.refresh !== undefined && (typeof input.refresh !== "boolean" || !piConsumption)
        || input.search_in !== undefined && (!piConsumption || input.search_in !== "metadata" && input.search_in !== "content")
        || input.refresh === true && input.cursor !== undefined
        || Object.keys(input).some(key => !["query", "source", "limit", ...(piConsumption ? ["cursor", "refresh", "search_in"] : [])].includes(key))) throw hostError("INVALID_ARGUMENT");
      if (input.search_in === "content") return searchContent(input, ctx, readSignal);
      const query = String(input.query ?? "").trim().toLocaleLowerCase();
      const sourceIds = (options.config.sources ?? []).filter(source => source.type === "notion" && source.enabled !== false).map(source => source.id);
      if (piConsumption && input.source !== undefined && !sourceIds.includes(String(input.source))) throw hostError("SOURCE_UNAVAILABLE");
      const selectedLibrary = options.librarySelection ? await options.librarySelection.selected(ctx) : undefined;
      const selectedSources = input.source === undefined ? selectedLibrary ? [selectedLibrary.source.id] : sourceIds : [String(input.source)];
      const explicitSource = input.source !== undefined && selectedLibrary && input.source !== selectedLibrary.source.id ? String(input.source) : undefined;
      const isolated = explicitSource !== undefined || options.librarySelection && !options.librarySelection.isCurrent(ctx)
        ? await options.getRecords(ctx, readSignal, input.refresh === true ? selectedSources : undefined, explicitSource) : undefined;
      if (!isolated) { revalidateMetadata(ctx, input.refresh === true ? selectedSources : undefined); await ready(readSignal); }
      if (!isolated && discoveryError) throw discoveryError;
      const listedRecords = isolated?.records ?? [...hostRecords.values()];
      const listedFailures = isolated?.failures ?? sourceFailures;
      const listedMetadata = isolated?.lists ?? metadataLists;
      const listedCoverage = isolated ? new Map((isolated.lists ?? []).map(list => [list.sourceId, list.exhaustive])) : catalogCoverage;
      const failures = listedFailures.filter(failure => selectedSources.includes(failure.sourceId));
      const coverage = selectedSources.map(source => ({ source, exhaustive: listedCoverage.get(source) ?? null }));
      const now = Date.now();
      const freshness = selectedSources.map(source => ({ source,
        ...notionListFreshness(listedMetadata.find(list => list.sourceId === source), now) }));
      const matches = listedRecords.filter(record => record.ref && record.source === "notion"
        && record.sourceId !== undefined && selectedSources.includes(record.sourceId)
        && (!query || [record.name, record.alias, record.description].some(value => value?.toLocaleLowerCase().includes(query))));
      const catalogKey = createHash("sha256").update(JSON.stringify([metadataGeneration, options.librarySelection?.key(ctx), query, selectedSources,
        matches.map(record => [recordIdentity(record), record.ref, record.name, record.description, observations.state(record)]), views, coverage, failures])).digest("hex");
      let offset = 0;
      if (typeof input.cursor === "string") {
        const cursor = /^(0|[1-9][0-9]*)\.([a-f0-9]{64})$/.exec(input.cursor);
        if (!cursor || cursor[2] !== catalogKey || !Number.isSafeInteger(Number(cursor[1])) || Number(cursor[1]) > matches.length) throw hostError("CATALOG_CURSOR_INVALID");
        offset = Number(cursor[1]);
      }
      const limit = Number(input.limit ?? 20), selected = matches.slice(offset, offset + limit);
      const references = modelCandidateReferences(selected, ctx);
      const result = {
        ok: true, state: "known", count: piConsumption ? selected.length : matches.length, has_more: matches.length > offset + selected.length,
        ...(piConsumption ? { total_count: matches.length,
          next_cursor: matches.length > offset + selected.length ? `${offset + selected.length}.${catalogKey}` : null,
          freshness: { sources: freshness },
          coverage: { exhaustive: failures.length || coverage.some(source => source.exhaustive === false) ? false
            : coverage.some(source => source.exhaustive === null) ? null : true, sources: coverage } } : {}),
        records: selected.map(record => ({
          id: record.id, ref: references.get(record) ?? record.ref, kind: record.kind, name: record.name, description: record.description,
          source: record.sourceId, scope: record.sourceScope, in_default_view: record.defaultDiscovery === true,
          availability: observations.state(record),
          ...(observations.denial(record) ? { error_code: observations.denial(record) } : {}),
        })),
        failures: (piConsumption ? failures : listedFailures).map(({ sourceId, code }) => ({ source: sourceId, code })),
      };
      checkPreparationSignal(readSignal);
      const active = host.getActiveTools?.();
      const model = adapter.paths.host === "pi" && active?.some(name => name === "read" || name === useToolName)
        ? { ...result, records: result.records.map(({ id: _id, scope: _scope, ...record }) => record) }
        : result;
      return { content: [{ type: "text", text: JSON.stringify(model) }], details: result };
    },
  });

  async function publish(record: SkillRecord, snapshot: SkillRecord, signal?: AbortSignal): Promise<void> {
    checkPreparationSignal(signal);
    if (!record.metadataIndexPath || record.metadataIndexPath === snapshot.path) return;
    const index = resolve(record.metadataIndexPath);
    const directory = dirname(index);
    if (basename(snapshot.path) !== basename(index)) throw hostError("SOURCE_ENTRY_CONFLICT");
    const content = snapshot.body!;
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    let metadata: Record<string, unknown> = {};
    let body = content;
    if (frontmatter) {
      try {
        const parsed: unknown = parseYaml(frontmatter[1]!);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
          body = content.slice(frontmatter[0].length);
        }
      } catch { /* A portable plain-Markdown entry can begin with a thematic break. */ }
    }
    const aliasContent = `---\n${stringifyYaml({ ...metadata, name: hostSkillName(record), description: record.description })}---\n${body}`;
    const previous = publishing.get(index);
    let release!: () => void;
    const pending = new Promise<void>((done) => { release = done; });
    publishing.set(index, pending);
    try {
      await previous;
      checkPreparationSignal(signal);
      if (recordIdentity(snapshot) !== recordIdentity(record)) throw hostError("SOURCE_IDENTITY_MISMATCH");
      const state = await lstat(directory);
      if (state.isSymbolicLink()) {
        if (await readFile(index, "utf8") === aliasContent && loaded.get(recordIdentity(record))?.record.path === snapshot.path) return;
        const target = await realpath(directory);
        const ownedRoot = join(await realpath(dirname(dirname(directory))), ".host-snapshots") + sep;
        if (!target.startsWith(ownedRoot)) throw hostError("SOURCE_INDEX_CONFLICT");
      }
      if (!state.isDirectory() && !state.isSymbolicLink()) throw hostError("SOURCE_INDEX_CONFLICT");
      const notion = options.config.sources?.some((source) => source.id === record.sourceId && source.type === "notion");
      if (notion && !snapshot.entryManifest) throw hostError("SOURCE_CACHE_VERSION_UNSUPPORTED");
      const snapshotRoot = snapshot.entryManifest?.root ?? dirname(resolve(snapshot.path));
      // Notion indexes contain the main; resource reads use the complete verified
      // file manifest. Local filesystem sources retain their own directory tree.
      const indexRoot = dirname(dirname(directory));
      const publishedRoot = join(indexRoot, ".host-snapshots", randomUUID());
      await mkdir(dirname(publishedRoot), { recursive: true, mode: 0o700 });
      if (!snapshot.entryManifest) await cp(snapshotRoot, publishedRoot, { recursive: true, errorOnExist: true, force: false });
      const publishedEntry = join(publishedRoot, relative(snapshotRoot, resolve(snapshot.path)));
      if (snapshot.entryManifest) await mkdir(dirname(publishedEntry), { recursive: true, mode: 0o700 });
      await writeFile(publishedEntry, aliasContent, { mode: 0o600 });
      if (snapshot.entryManifest) await writeFile(join(publishedRoot, ".broker-host-index.json"), JSON.stringify({
        version: 1, projection: "host_index", loaded: false,
        scope: snapshot.sourceScope, id: snapshot.id, snapshot_id: snapshot.snapshotId, version_id: snapshot.versionId,
        ref: snapshot.preparationBinding?.ref, entrypoint: snapshot.entrypoint,
        source: { bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") },
        published: { path: relative(publishedRoot, publishedEntry).split(sep).join("/"),
          bytes: Buffer.byteLength(aliasContent), sha256: createHash("sha256").update(aliasContent).digest("hex") },
        manifest_id: snapshot.entryManifest.manifest_id,
      }), { mode: 0o600, flag: "wx" });
      checkPreparationSignal(signal);
      const retiredRoot = join(indexRoot, ".retired-host-indexes");
      await mkdir(retiredRoot, { recursive: true, mode: 0o700 });
      checkPreparationSignal(signal);
      const retired = join(retiredRoot, randomUUID());
      await rename(directory, retired);
      try {
        checkPreparationSignal(signal);
        await symlink(dirname(publishedEntry), directory, "dir");
      }
      catch (error) { await rename(retired, directory); throw error; }
    } finally {
      release();
      if (publishing.get(index) === pending) publishing.delete(index);
    }
  }

  function observeFailure(error: unknown, ticket: ObservationTicket, selected: readonly SkillRecord[], fixed: ReadonlySet<string> = new Set(), ctx?: ExtensionContext): void {
    if (!(error instanceof SourceError) || !observations.current(ticket)) return;
    const known = [...selected, ...(ctx ? contextRecords(ctx) : hostRecords.values())];
    if (error.code === "AUTH_REQUIRED") {
      const scopes = new Set(selected.filter(record => record.sourceId === error.sourceId).map(record => record.sourceScope));
      for (const record of known)
        if (record.sourceId === error.sourceId && scopes.has(record.sourceScope)) observations.deny(record, ticket, "AUTH_REQUIRED");
    }
    for (const denial of error.details?.denials ?? []) {
      const deniedPage = denial.code === "ACCESS_DENIED"
        ? (denial.page_id ? notionPageId(denial.page_id) : /^https?:\/\//.test(denial.ref) ? notionPageId(denial.ref) : undefined)
        : undefined;
      let reference: ExactNativeReference | undefined;
      if (!deniedPage) try { reference = parseNativeReference(denial.ref); } catch { continue; }
      const targets = known.filter(record => {
        if (record.sourceId !== error.sourceId || record.sourceScope !== denial.scope || !record.ref) return false;
        if (deniedPage) return record.locator?.type === "shared_skill" && notionPageId(record.locator.page_id) === deniedPage;
        return record.id === denial.id && reference!.selector === parseNativeReference(record.ref).selector;
      });
      for (const target of targets) if (!(denial.code === "CONTENT_DISABLED" && (reference?.snapshot || fixed.has(recordIdentity(target)))))
        observations.deny(target, ticket, denial.code);
    }
  }

  async function graphPreparation(selected: readonly SkillRecord[], ctx: ExtensionContext | undefined, signal: AbortSignal, purpose: PreparationPurpose, pins?: ReadonlyMap<string, string>, mode: SelectionMode = "extend", commitNow = true, policy?: ConsumptionPolicy): Promise<{ records: SkillRecord[]; graphs: PreparedHostGraph[]; commit(): void }> {
    const owner = gate.active, observedGeneration = generation;
    const currentInspection = purpose === "inspect" && mode === "replace";
    const observedSession = ctx?.sessionManager?.getSessionId?.();
    const bindings = mode === "replace" ? [] : [...owner?.prepared.values() ?? []].flatMap(record => record.preparationBinding ? [record.preparationBinding] : []);
    const ticket = observations.begin(signal);
    const fixed = new Set([...selected, ...hostRecords.values()].filter(record => record.id && (pins?.has(record.id)
      || mode !== "replace" && (bindings.some(binding => binding.record.id === record.id)
        || ctx && options.sessionBinding?.(record, ctx)))).map(recordIdentity));
    let graphs: PreparedHostGraph[];
    try { graphs = await options.prepareGraph!(selected, ctx, signal, purpose, pins, bindings, mode, policy); }
    catch (error) { observeFailure(error, ticket, selected, fixed, ctx); throw error; }
    checkPreparationSignal(signal);
    if (generation !== observedGeneration || observedSession !== ctx?.sessionManager?.getSessionId?.()) throw preparationCancelled();
    if (owner) gate.assertCurrent(owner, ctx ?? owner.ctx);
    const values = graphs.flatMap(graph => graph.records);
    const assertQualification = () => {
      for (const record of values) {
        const denial = observations.denial(record);
        if (denial && (denial !== "CONTENT_DISABLED" || purpose === "use" || !fixed.has(recordIdentity(record))))
          throw new SourceError(denial, record.sourceId ?? "selection");
        if (!fixed.has(recordIdentity(record)) && !observations.canPublish(record, ticket)) throw preparationCancelled();
      }
    };
    const versions = new Map<string, string>();
    for (const record of values) {
      if (!record.sourceScope || !record.id || !record.snapshotId || !record.preparationBinding || typeof record.body !== "string") throw hostError("SOURCE_PREPARATION_INVALID");
      const canonical = JSON.stringify([record.sourceScope, record.id]);
      const version = JSON.stringify([record.snapshotId, record.preparationBinding.body_sha256]);
      if (versions.has(canonical) && versions.get(canonical) !== version) throw hostError("SOURCE_SESSION_CONFLICT");
      versions.set(canonical, version);
      const key = recordIdentity(record);
      const existing = owner?.prepared.get(key);
      if (mode !== "replace" && existing && (existing.snapshotId !== record.snapshotId || existing.body !== record.body)) throw hostError("SOURCE_SESSION_CONFLICT");
    }
    for (const record of values) if (!fixed.has(recordIdentity(record))) observations.observe(record, ticket);
    assertQualification();
    for (const record of values) {
      checkPreparationSignal(signal);
      const key = recordIdentity(record), metadata = hostRecords.get(key) ?? record;
      if (!currentInspection && record.kind === "skill") await publish(metadata, record, signal);
      checkPreparationSignal(signal);
      if (generation !== observedGeneration) throw preparationCancelled();
    }
    let committed = false;
    function commit() {
      if (committed) return;
      checkPreparationSignal(signal);
      if (generation !== observedGeneration || observedSession !== ctx?.sessionManager?.getSessionId?.()) throw preparationCancelled();
      if (owner) gate.assertCurrent(owner, ctx ?? owner.ctx);
      assertQualification();
      if (currentInspection) { committed = true; return; }
      let selection = ctx ? sessionSelection(ctx) : { scopes: new Map() };
      for (const transition of owner ? pendingGraphs.get(owner) ?? [] : [])
        selection = applySelectionGraphs(selection, { graphs: transition.graphs.map(graph => graph.lock), mode: transition.mode, selectionId: "pending-preparation" });
      const next = applySelectionGraphs(selection, { graphs: graphs.map(graph => graph.lock), mode, selectionId: "prepared" });
      // Exact root/File identity and response budgets are checked by the caller
      // before this transition. A failed refresh cannot replace the prior lock.
      if (ctx && purpose === "use") assertWorkingSetBudget(ctx, [...piRun?.graphs ?? [], { graphs, mode }], combineConsumptionEffects(graphs.map(graph => graph.effects)));
      if (deferredPiDiscovery && owner) {
        const staged = pendingGraphs.get(owner) ?? [];
        staged.push({ graphs, mode }); pendingGraphs.set(owner, staged);
      } else if (ctx) options.persistGraphs?.(graphs, ctx, mode);
      if (deferredPiDiscovery && piRun && purpose === "use") {
        piRun.graphs.push({ graphs, mode });
        for (const record of values) piRun.candidates.set(recordIdentity(record), record);
      }
      if (mode === "replace" && owner) {
        for (const [key, record] of owner.prepared) {
          if (record.source !== "notion" || !record.preparationBinding) continue;
          const binding = next.scopes.get(record.sourceScope!)?.bindings.get(record.id!);
          if (!binding || !samePreparationBinding(binding, record.preparationBinding)) {
            owner.prepared.delete(key); preparedForUse.get(owner)?.delete(key);
          }
        }
      }
      for (const record of values) {
        const key = recordIdentity(record), metadata = hostRecords.get(key) ?? record;
        hostRecords.set(key, metadata);
        if (record.kind !== "prompt") loaded.set(key, { record, owner });
        if (record.entryManifest) readRecords.set(resolve(record.path), record);
        owner?.prepared.set(key, record);
        graphSelectionCommits.delete(record);
      }
      if (owner && purpose === "use") {
        const ready = preparedForUse.get(owner) ?? new Set<string>();
        for (const record of values) ready.add(recordIdentity(record));
        preparedForUse.set(owner, ready);
      }
      committed = true;
    }
    if (commitNow) commit();
    else if (!currentInspection) for (const record of values) graphSelectionCommits.set(record, commit);
    return { records: values, graphs, commit };
  }

  async function prepareMany(selected: readonly SkillRecord[], ctx?: ExtensionContext, signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, lifecycleController.signal]) : lifecycleController.signal;
    const observedEffects: ConsumptionEffects[] = [];
    const policy: ConsumptionPolicy = { observeEffects: effects => observedEffects.push(effects) };
    try {
      await ready(combined);
      if (discoveryError) throw discoveryError;
      const graphRoots = [...new Map(selected.filter(record => record.source === "notion" && record.kind !== "prompt")
        .map(record => [recordIdentity(record), record])).values()]
        .filter(record => !gate.active || !preparedForUse.get(gate.active)?.has(recordIdentity(record)) && !misses.get(gate.active)?.has(recordIdentity(record)));
      if (options.prepareGraph && graphRoots.length) {
        const finish = feedback.begin(graphRoots[0]!, ctx, "use", options.config.sources?.find(source => source.id === graphRoots[0]!.sourceId && source.type === "notion"));
        try {
          const values = await graphPreparation(graphRoots, ctx, combined, "use", undefined, "extend", true, policy);
          observedEffects.push(combineConsumptionEffects(values.graphs.map(graph => graph.effects)));
          finish?.({ value: values.records[0]! });
        } catch (error) {
          if (!(error instanceof ReferenceMiss)) { finish?.({ error: combined.aborted ? "Cancelled." : failure(error) }); throw error; }
          checkPreparationSignal(combined);
          const missing = graphRoots.find(record => record.sourceId === error.sourceId && record.id === error.recordId);
          if (!missing) { finish?.({ error: failure(error) }); throw error; }
          if (gate.active) {
            const skipped = misses.get(gate.active) ?? new Set<string>();
            skipped.add(recordIdentity(missing)); misses.set(gate.active, skipped);
          }
          // A precise missing explicit root keeps the legacy unavailable result.
          // Required failures never become ReferenceMiss and cannot enter this path.
          for (const record of graphRoots) if (recordIdentity(record) !== recordIdentity(missing)) await prepare(record, ctx, combined, policy);
          finish?.({ skipped: true });
        }
      }
      for (const record of selected) if (!options.prepareGraph || record.source !== "notion" || record.kind === "prompt")
        await prepare(record, ctx, combined, record.source === "notion" ? policy : undefined);
    } catch (error) {
      if (!observedEffects.length) throw error;
      const effects = combineConsumptionEffects([...observedEffects, errorConsumptionEffects(error)]);
      throw consumptionFailure(error, JSON.stringify({ error: failure(error), effects }), effects);
    }
  }

  function assertRecordSourceAvailable(record: SkillRecord, failures: readonly SourceFailure[] = sourceFailures): void {
    if (record.sourceId) {
      const library = record.locator?.type === "shared_skill" ? record.locator.library_id : undefined;
      const currentScope = catalogScopes.get(JSON.stringify([record.sourceId, library]));
      if (record.sourceScope && currentScope && record.sourceScope !== currentScope) throw new SourceError("SOURCE_IDENTITY_MISMATCH", record.sourceId);
      if (failures === sourceFailures && options.librarySelection && library !== metadataSourceLibraries.get(record.sourceId)) return;
      const unavailable = failures.find(failure => failure.sourceId === record.sourceId && failure.blocking !== false);
      if (unavailable) throw new SourceError(unavailable.code, unavailable.sourceId);
    }
  }

  function assertSourceSelection(record: SkillRecord, ctx?: ExtensionContext, requestedSnapshot?: string): { snapshot: string | undefined; binding: PreparationBinding | undefined } {
    assertRecordSourceAvailable(record);
    if (gate.active) gate.assertCurrent(gate.active, ctx ?? gate.active.ctx);
    const binding = ctx ? options.sessionBinding?.(record, ctx) : undefined;
    const activeSnapshot = binding?.snapshot_id ?? (ctx ? options.sessionSnapshot?.(record, ctx) : undefined);
    if (requestedSnapshot && activeSnapshot && requestedSnapshot !== activeSnapshot) throw hostError("SOURCE_SESSION_CONFLICT");
    const denied = observations.denial(record);
    if ((requestedSnapshot || activeSnapshot) && denied && denied !== "CONTENT_DISABLED")
      throw new SourceError(denied, record.sourceId ?? "selection");
    return { snapshot: requestedSnapshot ?? activeSnapshot, binding };
  }

  function reusableLoadedSnapshot(record: SkillRecord, ctx: ExtensionContext | undefined, snapshot: string | undefined): SkillRecord | undefined {
    const pinned = loaded.get(recordIdentity(record));
    return record.kind !== "prompt" && pinned && (!snapshot || pinned.record.snapshotId === snapshot)
      && ((ctx && options.isLoaded?.(pinned.record, ctx)) || (gate.active && pinned.owner === gate.active)) ? pinned.record : undefined;
  }

  function contextRecords(ctx: ExtensionContext): SkillRecord[] {
    return [...hostRecords.values(), ...readRecords.values(), ...[...loaded.values()].map(value => value.record),
      ...[...activeSources(ctx).sources.values()].map(value => value.record)];
  }

  function assertContextAccess(messages: AgentMessage[], ctx: ExtensionContext): void {
    const known = contextRecords(ctx);
    for (const identity of contextSourceIdentities(messages)) {
      for (const record of known.filter(record => record.sourceScope === identity.scope && record.id === identity.id)) {
        assertRecordSourceAvailable(record);
        const denial = observations.denial(record);
        if (denial && denial !== "CONTENT_DISABLED") throw new SourceError(denial, record.sourceId ?? "selection");
      }
    }
  }

  function unavailableContextSource(scope: string, id: string, ctx: ExtensionContext): "unavailable" | undefined {
    const known = contextRecords(ctx);
    return known.filter(record => record.sourceScope === scope && record.id === id).some(record => {
      try { assertRecordSourceAvailable(record); } catch { return true; }
      const denial = observations.denial(record);
      return denial !== undefined && denial !== "CONTENT_DISABLED";
    }) ? "unavailable" : undefined;
  }

  function assertCanRestore(record: SkillRecord): void {
    assertRecordSourceAvailable(record);
    const denial = observations.denial(record);
    // Business Enabled governs current selection. Exact previously confirmed
    // bytes may be restored; acquisition of missing bytes still goes through
    // the SDK's current eligibility checks. Authorization never gets this rule.
    if (denial && denial !== "CONTENT_DISABLED") throw new SourceError(denial, record.sourceId ?? "selection");
  }

  async function activate(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal, waitForTool = false, readPhase: "hook" | "execute" = "hook", requestedSnapshot?: string, policy?: ConsumptionPolicy): Promise<SkillRecord> {
    signal = signal ? AbortSignal.any([signal, lifecycleController.signal]) : lifecycleController.signal;
    checkPreparationSignal(signal);
    await ready(signal);
    const { snapshot: sessionSnapshot } = assertSourceSelection(record, ctx, requestedSnapshot);
    const key = recordIdentity(record);
    const prepared = gate.active?.prepared.get(key);
    const graphUse = !waitForTool && options.prepareGraph && record.source === "notion" && record.kind !== "prompt";
    if (prepared && (!graphUse || gate.active && preparedForUse.get(gate.active)?.has(key))) {
      if (sessionSnapshot && prepared.snapshotId !== sessionSnapshot) throw hostError("SOURCE_SESSION_CONFLICT");
      checkPreparationSignal(signal);
      policy?.observeEffects?.(noConsumptionWrites());
      return prepared;
    }
    record = hostRecords.get(key) ?? record;
    const selectedGeneration = generation;
    const directObservation = observations.begin(signal);
    const direct = !options.prepareGraph || record.source !== "notion" || record.kind === "prompt";
    const preparationOwner = gate.active;
    const existing = reusableLoadedSnapshot(record, ctx, sessionSnapshot);
    if (existing && !graphUse) { await publish(record, existing, signal); checkPreparationSignal(signal); policy?.observeEffects?.(noConsumptionWrites()); return existing; }
    // A preparation owns its signal. Unrelated consumers never inherit its cancellation.
    const pending = loading.get(key);
    const reusable = pending !== undefined && !pending.signal?.aborted && pending.signal === signal;
    const finish = !waitForTool ? feedback.begin(record, ctx, graphUse ? "use" : undefined, options.config.sources?.find(source => source.id === record.sourceId && source.type === "notion")) : undefined;
    const cancelled = () => finish?.({ error: "Cancelled." });
    signal?.addEventListener("abort", cancelled, { once: true });
    const operation = reusable ? pending!.operation : (async () => {
      // Commands and native tool execution are outside OMP's short event-hook budget.
      // A command keeps this ownership across source queueing and its nested preflight.
      const outsideHook = readPhase === "execute" || Boolean(preparationOwner && commandPreparations.has(preparationOwner));
      const load = async (child: AbortSignal) => {
        if (!options.prepareGraph || record.source !== "notion" || record.kind === "prompt") return options.loadRecord(record, child, sessionSnapshot, policy);
        const values = await graphPreparation([record], ctx, child, waitForTool ? "inspect" : "use", sessionSnapshot && record.id ? new Map([[record.id, sessionSnapshot]]) : undefined, "extend", !waitForTool, policy);
        policy?.observeEffects?.(combineConsumptionEffects(values.graphs.map(graph => graph.effects)));
        const result = values.records.find(item => recordIdentity(item) === key);
        if (!result) throw hostError("SOURCE_PREPARATION_INVALID");
        return result;
      };
      let result = !outsideHook && adapter.headlessActivationTimeoutMs !== undefined && ctx?.mode !== "tui"
        ? await headlessActivation(load, adapter.headlessActivationTimeoutMs, signal)
        : await load(signal);
      checkPreparationSignal(signal);
      if (typeof result.body !== "string" || !result.body.trim()) throw hostError("SOURCE_BODY_MISSING");
      if (recordIdentity(result) !== key) throw hostError("SOURCE_IDENTITY_MISMATCH");
      if (sessionSnapshot && result.snapshotId !== sessionSnapshot) throw hostError("SOURCE_IDENTITY_MISMATCH");
      if (direct && record.source === "notion") {
        if (!sessionSnapshot) observations.observe(result, directObservation);
        const denial = observations.denial(record);
        if (denial && (denial !== "CONTENT_DISABLED" || !sessionSnapshot || !waitForTool)) throw new SourceError(denial, record.sourceId ?? "selection");
        if (!sessionSnapshot && !observations.canPublish(record, directObservation)) throw preparationCancelled();
      }
      if (options.config.sources?.some((source) => source.id === record.sourceId && source.type === "filesystem")) {
        filesystemCache ??= await mkdtemp(join(tmpdir(), "context-broker-host-"));
        const root = join(filesystemCache, ".snapshots", randomUUID());
        await mkdir(dirname(root), { recursive: true, mode: 0o700 });
        await cp(dirname(result.path), root, { recursive: true, force: false, errorOnExist: true });
        checkPreparationSignal(signal);
        const entry = join(root, basename(result.path));
        await writeFile(entry, result.body, { mode: 0o600 });
        result = { ...result, path: entry };
      }
      checkPreparationSignal(signal);
      if (generation !== selectedGeneration) throw preparationCancelled();
      if (record.kind === undefined || record.kind === "skill") await publish(record, result, signal);
      checkPreparationSignal(signal);
      if (generation === selectedGeneration && !graphSelectionCommits.has(result)) {
        if (record.kind !== "prompt") loaded.set(key, { record: result, owner: preparationOwner });
        if (result.entryManifest) readRecords.set(resolve(result.path), result);
        preparationOwner?.prepared.set(key, result);
      }
      return result;
    })().then<ActivationOutcome<SkillRecord>, ActivationOutcome<SkillRecord>>(
      value => ({ ok: true, value }), error => ({ ok: false, error }),
    );
    const owner = reusable ? pending! : { operation, signal };
    if (!reusable) loading.set(key, owner);
    try {
      // Real read has its own native row. Only pause its hook budget, never add a display row.
      const outcome = waitForTool && readPhase === "hook" && ctx?.hasUI && ctx.mode === "tui" && ctx.ui?.custom
        ? await ctx.ui.custom<ActivationOutcome<SkillRecord>>((_tui, _theme, _keys, done) => {
          void operation.then(done);
          return { render: () => [], invalidate() {} };
        }, { overlay: true, overlayOptions: { visible: () => false } })
        : await operation;
      checkPreparationSignal(signal);
      if (!outcome.ok) throw outcome.error;
      if (generation !== selectedGeneration) throw preparationCancelled();
      if (direct && !sessionSnapshot) observations.observe(outcome.value, directObservation);
      finish?.({ value: outcome.value });
      return outcome.value;
    } catch (error) {
      if (direct && error instanceof SourceError && (error.code === "CONTENT_DISABLED" && !sessionSnapshot
        || error.code === "ACCESS_DENIED" || error.code === "AUTH_REQUIRED"))
        observations.deny(record, directObservation, error.code);
      finish?.(error instanceof ReferenceMiss ? { skipped: true } : { error: signal?.aborted ? "Cancelled." : failure(error) });
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelled);
      if (loading.get(key) === owner) loading.delete(key);
    }
  }

  async function prepare(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal, policy?: ConsumptionPolicy): Promise<PreparedReference> {
    const entry = gate.active;
    const key = recordIdentity(record);
    if (entry && misses.get(entry)?.has(key)) return { status: "miss" };
    try { return { status: "ready", record: await activate(record, ctx, signal, false, "hook", undefined, policy) }; }
    catch (error) {
      if (!(error instanceof ReferenceMiss)) throw error;
      checkPreparationSignal(signal);
      if (entry) {
        gate.assertCurrent(entry, ctx);
        const skipped = misses.get(entry) ?? new Set<string>();
        skipped.add(key);
        misses.set(entry, skipped);
      }
      return { status: "miss" };
    }
  }

  function notify(ctx: ExtensionContext, error: unknown): void { ctx.ui?.notify?.(failure(error), "error"); }
  function nativeRecord(text: string): SkillRecord | undefined {
    const match = /^\s*\/skill:([^\s]+)/.exec(invocationText(text));
    return match ? nativeNames.get(match[1]!) : undefined;
  }
  function needsPreparation(text: string): boolean {
    return Boolean(/^\s*\/skill:[^\s]+/.test(text) || options.needsPreflightPrompt?.(text));
  }
  async function preflight(text: string, ctx: ExtensionContext, signal?: AbortSignal, selectedNative?: SkillRecord): Promise<void> {
    checkPreparationSignal(signal);
    const selection = needsPreparation(text);
    if (!deferredPiDiscovery || selection) await ready(signal);
    text = invocationText(text);
    if (discoveryError && (deferredPiDiscovery ? selection : /(?:^|\s)(?:\$[^\s]+|\/skill:[^\s]+)/.test(text))) throw discoveryError;
    const candidate = selectedNative ?? nativeRecord(text);
    const record = candidate && (selectedNative || visibleInLibrary(candidate, ctx)) ? candidate : undefined;
    if (record) await prepare(record, ctx, signal);
    await options.preflightPrompt?.(text, ctx, signal);
    checkPreparationSignal(signal);
  }

  function registerNativeCommands(): void {
    if (adapter.submission.mode !== "command" || !host.registerCommand) return;
    for (const record of hostRecords.values()) {
      if (record.kind !== undefined && record.kind !== "skill") continue;
      const name = hostSkillName(record);
      if (registeredCommands.has(name)) continue;
      registeredCommands.add(name);
      const handler = async (args: string, ctx: ExtensionContext, images?: ImageContent[], accepted?: ActivePreparation): Promise<void> => {
        const text = `/skill:${name}${args ? ` ${args}` : ""}`;
        const continuation = gate.active?.phase === "dispatching" && !gate.active.forwarded && gate.active.event.text === text ? gate.active : undefined;
        accepted ??= continuation;
        if (gate.active && gate.active !== accepted) { ctx.ui?.notify?.("A Skill submission is still preparing.", "info"); return; }
        const entry = accepted ?? beginPreparation({ text, images }, ctx);
        const ownsCommandPreparation = !commandPreparations.has(entry);
        if (ownsCommandPreparation) commandPreparations.add(entry);
        images ??= entry.event.images;
        if (continuation) continuation.forwarded = true;
        try {
          gate.assertCurrent(entry, ctx);
          await ready(entry.controller.signal);
          if (discoveryError) throw discoveryError;
          const selected = nativeNames.get(name);
          const prepared = selected ? await prepare(selected, ctx, entry.controller.signal) : { status: "miss" as const };
          const snapshot = prepared.status === "ready" ? prepared.record : undefined;
          await options.preflightPrompt?.(args, ctx, entry.controller.signal);
          if (!host.sendUserMessage) throw hostError("HOST_SKILL_API_UNAVAILABLE");
          const alreadyLoaded = snapshot ? options.isLoaded?.(snapshot, ctx) ?? false : false;
          let submitted: string;
          if (!snapshot) {
            submitted = await options.taskPrompt?.(entry.event.text ?? text, ctx, entry.controller.signal, entry) ?? entry.event.text ?? text;
            const unavailable = [{ record: selected ?? record, query: "/skill:" + name }];
            notifyUnavailableReferences(ctx, unavailable);
            submitted += "\n\n" + renderUnavailableReferences(unavailable);
          } else if (alreadyLoaded) {
            args = await options.taskPrompt?.(args, ctx, entry.controller.signal, entry) ?? args;
            // A plain invocation retains user intent without expanding /skill a second time.
            submitted = `Use the already loaded Skill ${hostSkillName(snapshot)}.${args ? `\n\n${args}` : ""}`;
          } else {
            args = await options.taskPrompt?.(args, ctx, entry.controller.signal, entry) ?? args;
            submitted = await adapter.buildPrompt(snapshot, args, entry.event.text ?? "");
          }
          gate.assertCurrent(entry, ctx);
          entry.phase = "dispatching";
          handoff = { entry, prompts: [entry.event.text ?? text, submitted], consumed: false, ...(snapshot && !alreadyLoaded ? { native: { snapshot, promptSha256: createHash("sha256").update(submitted).digest("hex") } } : {}) };
          // The user-message path runs before_agent_start; custom triggerTurn bypasses that gate.
          // Both public send APIs return void, so print must wait for the real turn's agent_end.
          let complete: (() => void) | undefined;
          const finished = ctx.mode === "print" || ctx.mode === "json" ? new Promise<void>((resolve) => { complete = resolve; printTurns.add(resolve); }) : undefined;
          const cancelled = () => complete?.();
          entry.controller.signal.addEventListener("abort", cancelled, { once: true });
          try {
            host.sendUserMessage(images?.length ? [{ type: "text", text: submitted }, ...images] : submitted);
            await finished;
          } finally {
            entry.controller.signal.removeEventListener("abort", cancelled);
            if (complete) printTurns.delete(complete);
          }
        } catch (error) { const restore = gate.active === entry && !entry.controller.signal.aborted; gate.release(entry); if (restore) { ctx.ui?.setEditorText?.(entry.event.text ?? text); notify(ctx, error); } }
        finally { if (ownsCommandPreparation) commandPreparations.delete(entry); }
      };
      nativeCommands.set(name, handler);
      host.registerCommand(`skill:${name}`, { description: record.description, handler });
    }
  }

  async function updateDirectories(signal: AbortSignal): Promise<void> {
    metadataFallback = !await adapter.registerCatalog(records, signal);
  }

  async function refreshMetadata(ctx?: ExtensionContext, announce = true, preserveTurn = false, refreshSourceIds?: readonly string[]): Promise<void> {
    ctx = ctx && options.librarySelection ? options.librarySelection.capture(ctx) : ctx;
    const selectedGeneration = ++metadataGeneration;
    metadataController.abort();
    metadataController = new AbortController();
    const metadataSignal = metadataController.signal;
    metadataPending = true;
    metadataRefreshSources = new Set(refreshSourceIds);
    if (!preserveTurn) {
      generation++;
      lifecycleController.abort();
      lifecycleController = new AbortController();
      gate.cancel();
      turnPrompts = undefined;
    }
    const observation = observations.begin(metadataSignal);
    try {
      const result = await options.getRecords(ctx, metadataSignal, refreshSourceIds);
      if (metadataGeneration !== selectedGeneration || ctx && options.librarySelection && !options.librarySelection.isCurrent(ctx)) return;
      // Shared Notion metadata indexes stay immutable; published native views belong to this host process.
      const next = result.records.filter(record => record.sourceId !== undefined).map(record => record.source === "notion" ? { ...record, metadataIndexPath: undefined } : record);
      const missing = next.filter(record => (record.kind === undefined || record.kind === "skill") && !record.metadataIndexPath && (record.source !== "notion" || record.defaultDiscovery === true));
      if (missing.length) {
        filesystemCache ??= await mkdtemp(join(tmpdir(), "context-broker-host-"));
        const index = join(filesystemCache, "indexes", randomUUID());
        await mkdir(index, { recursive: true, mode: 0o700 });
        for (const record of missing) {
          const directory = join(index, randomUUID());
          await mkdir(directory, { mode: 0o700 });
          const metadataIndexPath = join(directory, "SKILL.md");
          await writeFile(metadataIndexPath, `---\n${stringifyYaml({ name: hostSkillName(record), description: record.description })}---\n`, { mode: 0o600, flag: "wx" });
          next[next.indexOf(record)] = { ...record, metadataIndexPath };
        }
      }
      const names = new Map<string, SkillRecord>();
      for (const record of next) {
        if (record.kind !== undefined && record.kind !== "skill") continue;
        const name = hostSkillName(record);
        if (names.has(name) && recordIdentity(names.get(name)!) !== recordIdentity(record)) throw hostError("SOURCE_HOST_NAME_CONFLICT");
        names.set(name, record);
      }
      const previous = catalogPublication;
      let release!: () => void;
      catalogPublication = new Promise<void>((done) => { release = done; });
      await previous;
      try {
        if (metadataGeneration !== selectedGeneration || ctx && options.librarySelection && !options.librarySelection.isCurrent(ctx)) return;
        sourceFailures = result.failures;
        metadataLists = result.lists ?? [];
        metadataLibraryKey = ctx && options.librarySelection?.key(ctx);
        metadataSourceLibraries = new Map((ctx ? libraryContext(ctx)?.local()?.sources : undefined)?.map(source => [source.id, source.library])
          ?? (options.config.sources ?? []).filter(source => source.type === "notion").map(source => [source.id, source.library]));
        for (const list of metadataLists) if (list.scope) catalogScopes.set(JSON.stringify([list.sourceId, metadataSourceLibraries.get(list.sourceId)]), list.scope);
        for (const record of next) if (record.sourceId && record.sourceScope) catalogScopes.set(JSON.stringify([record.sourceId,
          record.locator?.type === "shared_skill" ? record.locator.library_id : undefined]), record.sourceScope);
        metadataRetryAt = sourceFailures.length ? Date.now() + notionCatalogRetryGapMs : 0;
        catalogCoverage = new Map((result.lists ?? []).flatMap(list => typeof list.exhaustive === "boolean" ? [[list.sourceId, list.exhaustive]] : []));
        views = result.views ?? [];
        defaultRouters = next.filter(record => record.kind === "router" && record.defaultDiscovery === true);
        records = next.filter(record => (record.kind === undefined || record.kind === "skill") && (!options.config.sources?.some(source => source.id === record.sourceId && source.type === "notion") || record.defaultDiscovery === true));
        nativeNames.clear();
        hostRecords.clear();
        for (const [name, record] of names) nativeNames.set(name, record);
        for (const record of next) {
          observations.observe(record, observation);
          hostRecords.set(recordIdentity(record), record);
          readRecords.set(resolve(record.metadataIndexPath ?? record.path), record);
          readRecords.set(resolve(record.path), record);
        }
        nativeInputs.clear();
        loading.clear();
        discoveryError = undefined;
        await updateDirectories(metadataSignal);
        if (metadataGeneration !== selectedGeneration || ctx && options.librarySelection && !options.librarySelection.isCurrent(ctx)) return;
        for (const record of records) for (const path of adapter.catalogPaths?.(record) ?? []) readRecords.set(resolve(path), record);
        registerNativeCommands();
        options.onMetadata?.(next);
        if (ctx) {
          for (const message of formatSourceFailures(sourceFailures)) ctx.ui?.notify?.(message, "warning");
          if (announce) ctx.ui?.notify?.(sourceFailures.length || views.some(view => view.status === "error")
            ? "context-broker: source metadata update incomplete; inspect the reported failures"
            : "context-broker: source metadata refreshed", sourceFailures.length ? "warning" : "info");
        }
        // Pi projects this observation at each provider boundary; View switches do not reload the session.
      } finally { release(); }
    } catch (error) { if (metadataGeneration === selectedGeneration && (!ctx || !options.librarySelection || options.librarySelection.isCurrent(ctx))) { discoveryError = error; metadataRetryAt = Date.now() + notionCatalogRetryGapMs; if (ctx) notify(ctx, error); } }
    finally { if (metadataGeneration === selectedGeneration) { metadataPending = false; metadataRefreshSources = new Set(); } }
  }

  function refresh(ctx?: ExtensionContext, announce = true, preserveTurn = false): Promise<void> {
    metadataReadiness = refreshMetadata(ctx, announce, preserveTurn);
    return metadataReadiness;
  }

  if (adapter.submission.mode === "command" && host.registerCommand) host.registerCommand("context-broker-submit", {
    description: "Activate selected source Skills and resume the submitted prompt",
    async handler(id, ctx) {
      ctx = turnContext(ctx);
      const entry = gate.active;
      if (!entry || entry.id !== id) return;
      const ownsCommandPreparation = !commandPreparations.has(entry);
      if (ownsCommandPreparation) commandPreparations.add(entry);
      try {
        gate.assertCurrent(entry, ctx);
        const original = entry.event.text ?? "";
        let text = original;
        await preflight(text, ctx, entry.controller.signal);
        gate.assertCurrent(entry, ctx);
        const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
        if (match && nativeCommands.has(match[1]!)) {
          await nativeCommands.get(match[1]!)!(match[2] ?? "", ctx, entry.event.images, entry);
        } else {
          text = await options.taskPrompt?.(text, ctx, entry.controller.signal, entry) ?? text;
          if (!host.sendUserMessage) throw hostError("HOST_SKILL_API_UNAVAILABLE");
          entry.phase = "dispatching";
          handoff = { entry, prompts: [original, text], consumed: false };
          gate.assertCurrent(entry, ctx);
          host.sendUserMessage(entry.event.images?.length ? [{ type: "text", text }, ...entry.event.images] : text);
        }
      } catch (error) { const restore = gate.active === entry && !entry.controller.signal.aborted; gate.release(entry); if (restore) { ctx.ui?.setEditorText?.(entry.event.text ?? ""); notify(ctx, error); } }
      finally { if (ownsCommandPreparation) commandPreparations.delete(entry); }
    },
  });
  for (const event of ["session_before_switch", "session_before_branch", "session_before_tree"] as const) host.on(event, () => {
    generation++;
    lifecycleController.abort();
    lifecycleController = new AbortController();
    gate.cancel(false);
    turnPrompts = undefined;
    nativeInputs.clear();
  });
  for (const event of ["session_start", "session_switch", "session_tree", "session_branch"] as const) host.on(event, async (_event, ctx) => {
    acceptedContext = undefined;
    runningContext = undefined;
    // A successful host session boundary acknowledges disposal of its pending turn.
    generation++;
    lifecycleController.abort();
    lifecycleController = new AbortController();
    gate.cancel(false);
    const entry = gate.active;
    if (entry) gate.release(entry);
    handoff = undefined;
    turnPrompts = undefined;
    nativeInputs.clear();
    pendingNativeReads.clear();
    pendingResourceReads.clear();
    loaded.clear();
    feedback.restore(ctx);
    await adapter.installEditor(ctx, gate.bindEditor);
    const ready = refresh(ctx, false);
    // Session navigation must remain usable while metadata is in flight.
    // Pi ordinary submissions use the available observation without joining this
    // work. Explicit selections still await metadataReadiness before preparation.
    void ready.catch(() => undefined);
  });
  host.on("session_shutdown", () => {
    acceptedContext = undefined;
    runningContext = undefined;
    generation++;
    metadataGeneration++;
    metadataController.abort();
    lifecycleController.abort();
    gate.cancel(false);
    if (ownsFinalRequests) finalRequests.close();
    else finalRequests.retire();
    const entry = gate.active;
    if (entry) gate.release(entry);
    handoff = undefined;
    turnPrompts = undefined;
    nativeInputs.clear();
  });
  host.on("agent_start", (_event, ctx) => {
    const entry = gate.active;
    const receipt = entry && handoff?.entry === entry && handoff.consumed ? handoff : undefined;
    runningContext = receipt?.entry.ctx;
    if (deferredPiDiscovery) {
      // This is the first public boundary with Pi's actual operation signal.
      // Preserve the accepted submission's controller: accepted choices use it as
      // their identity, and cancellation must revoke those choices as well.
      const preparedEntry = receipt && needsPreparation(receipt.entry.event.text ?? "") ? receipt.entry : undefined;
      const signal = ctx.signal ?? lifecycleController.signal;
      if (receipt) {
        const abort = () => receipt.entry.controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      piRun = { generation, sessionId: ctx.sessionManager?.getSessionId?.(), signal,
        entry: preparedEntry, selectedNative: receipt?.selectedNative,
        prepared: false, requestPending: false, confirmed: false, persisted: 0,
        candidates: new Map(), graphs: [] };
      // Plain input owns admission only until this run exists. Its Library stays
      // frozen in runningContext; it must not stage later tool graph transitions
      // behind the explicit-Skill preparation acknowledgement boundary.
      if (receipt && !preparedEntry) { gate.release(receipt.entry); handoff = undefined; }
      return;
    }
    if (entry?.phase === "dispatching" && handoff?.entry === entry && handoff.consumed) {
      try {
        gate.assertCurrent(entry, ctx);
        turnPrompts = { snapshots: new Map([...entry.prepared].filter(([, record]) => record.kind === "prompt")), signal: entry.controller.signal };
        gate.release(entry);
        handoff = undefined;
      }
      catch { ctx.abort?.(); gate.cancel(); }
    }
  });
  api.on("context", async (event, ctx) => {
    ctx = turnContext(ctx);
    const run = deferredPiDiscovery ? piRun : undefined;
    try {
      const contextEntries = deferredPiDiscovery ? ctx.sessionManager?.buildSessionProjection?.().entries ?? [] : [];
      if (run) {
        assertPiRun(run, ctx);
        acknowledgeProjection(run, contextEntries);
        run.userEntryId ??= contextEntries.findLast(entry => entry.sourceEntry.type === "message"
          && entry.messages.some(message => message.role === "user"))?.sourceEntry.id;
        // A one-shot print has no later turn for a late default directory. Join
        // metadata only here, under the real operation's cancellation signal.
        if (!run.prepared) revalidateMetadata(ctx);
        if (!run.prepared && (ctx.mode === "print" || ctx.mode === "json")) {
          await ready(AbortSignal.any([run.signal, lifecycleController.signal]));
          assertPiRun(run, ctx);
        }
        if (!run.prepared && run.entry) {
          const entry = run.entry, text = entry.event.text ?? "", signal = entry.controller.signal;
          gate.assertCurrent(entry, ctx);
          await preflight(text, ctx, signal, run.selectedNative);
          assertPiRun(run, ctx);
          const task = await options.taskPrompt?.(text, ctx, signal, entry) ?? text;
          assertPiRun(run, ctx);
          const message = needsPreparation(text) ? await options.buildPreparedPrompt?.(text, ctx, signal, [...entry.prepared.values()]) : undefined;
          assertPiRun(run, ctx);
          for (const record of entry.prepared.values()) if (record.kind !== "prompt") run.candidates.set(recordIdentity(record), record);
          run.projection = message ? [{ ...message, role: "custom", timestamp: Date.now() }] : [];
          if ([...entry.prepared.values()].some(record => record.source === "notion")) {
            const graphs = (pendingGraphs.get(entry) ?? []).flatMap(staged => staged.graphs);
            // Bind disclosure to this acquisition, never to a retained snapshot's
            // historical writes. Separate text preserves every source body span.
            const effects = graphs.length ? combineConsumptionEffects(graphs.map(graph => graph.effects)) : consumptionEffects(undefined);
            run.projection.push({ role: "custom", customType: "context-broker-consumption-effects",
              content: "<notion-effects>" + JSON.stringify(effects) + "</notion-effects>",
              display: false, details: { effects }, timestamp: Date.now() });
          }
          if (task !== text) run.projection.push({ role: "custom", customType: "context-broker-task",
            content: task.startsWith(text) ? task.slice(text.length).trimStart() : task, display: false,
            details: { version: 1, invocation: entry.id }, timestamp: Date.now() });
          turnPrompts = { snapshots: new Map([...entry.prepared].filter(([, record]) => record.kind === "prompt")), signal };
        }
        if (run) run.prepared = true;
      }
      let messages = withSessionSourceReceipts(event.messages.filter(message => message.customType !== ACTIVATION_MESSAGE
        && message.customType !== RECOVERY_NOTICE), contextEntries);
      // Keep the submitted user content, including /skill's protection newline,
      // identical to the projection bound by persisted source delivery receipts.
      const projectionIndices: number[] = [];
      for (const projected of run?.projection?.slice(run.persisted) ?? []) {
        projectionIndices.push(messages.length);
        messages = [...messages, projected];
      }
      messages = options.projectContext?.(messages, ctx, run?.graphs) ?? messages;
      messages = projectSelectedSourceMessages(messages, { scopes: new Map() }, (scope, id) => unavailableContextSource(scope, id, ctx));
      if (run && options.restoreActive) {
        const restored = await options.restoreActive(messages, ctx, AbortSignal.any([run.signal, lifecycleController.signal]), run.graphs);
        assertPiRun(run, ctx);
        messages = restored.messages;
        for (const addition of restored.restored) {
          const message = { ...addition, role: "custom", timestamp: Date.now() };
          (run.projection ??= []).push(message); projectionIndices.push(messages.length); messages = [...messages, message];
        }
        // Capability warnings describe this request, not a new activation or a
        // native-history edit. Recompute them without appending persistent spam.
        messages = [...messages, ...restored.notices.map(message => ({ ...message, role: "custom", timestamp: Date.now() }))];
        messages = projectSelectedSourceMessages(messages, { scopes: new Map() }, (scope, id) => unavailableContextSource(scope, id, ctx));
      }
      messages = deduplicateSourceReads(messages);
      assertContextAccess(messages, ctx);
      if (run) {
        assertPiRun(run, ctx); run.contextMessages = structuredClone(messages); run.finalMessages = undefined;
        run.requestProjection = { count: run.projection?.length ?? 0, messages: projectionIndices.map(index => messages[index]!) };
      }
      // Receipt-only custom entries support validation above, never model input.
      return { messages: messages.filter(message => !(message.role === "custom" && message.customType === "context-broker"
        && !sourceMessageText(message.content) && message.details && typeof message.details === "object" && "nativePromptSha256" in message.details)) };
    } catch (error) {
      // An already cancelled Pi operation cannot dispatch. Do not report normal
      // Stop as an extension failure; acquisition errors below must still abort.
      if (run?.signal.aborted && piRun === run && generation === run.generation) return undefined;
      // Pi reports extension errors and continues; aborting the current operation
      // is what actually prevents provider dispatch after failed acquisition.
      if (!run || !run.signal.aborted && piRun === run && generation === run.generation) ctx.abort?.();
      throw error;
    }
  });
  if (deferredPiDiscovery) {
    host.on("before_provider_request", (event, ctx) => {
      const run = piRun;
      if (!run) return;
      try {
        assertPiRun(run, ctx);
        assertContextAccess(run.contextMessages ?? [], ctx);
        assertActiveContextDelivery(ctx, run.contextMessages ?? [], run.finalMessages ?? run.contextMessages ?? [], run.graphs);
        const decision = finalRequests.inspect({
          messages: run.finalMessages ?? run.contextMessages ?? [],
          payload: event.payload,
          api: ctx.model?.api,
          baseUrl: ctx.model?.baseUrl,
          sessionId: run.sessionId,
          generation: run.generation,
          signal: run.signal,
        });
        // A known serialized mismatch must not become active, selected, or persisted.
        // Abort is the host's cancellation; the ledger still records a later send as dispatched.
        if (decision.block) {
          run.wireBlock = true;
          run.requestPending = false;
          run.confirmedProjection = undefined;
          if (piRun === run && generation === run.generation) ctx.abort?.();
          return;
        }
        run.wireBlock = false;
        run.requestPending = true;
        run.confirmedProjection = undefined;
      }
      catch (error) { if (piRun === run && generation === run.generation) ctx.abort?.(); throw error; }
    });
    host.on("after_provider_response", (event, ctx) => {
      const run = piRun;
      const provider = run ? finalRequests.observeProvider(run.signal, event.status, run.generation) : { blocked: false };
      if (!run?.requestPending || event.status < 200 || event.status >= 300) return;
      if (run.wireBlock || provider.blocked) {
        run.requestPending = false;
        if (!run.signal.aborted && piRun === run && generation === run.generation) ctx.abort?.();
        return;
      }
      try {
        assertPiRun(run, ctx);
        if (!run.confirmed && run.entry) for (const staged of pendingGraphs.get(run.entry) ?? []) options.persistGraphs?.(staged.graphs, ctx, staged.mode);
        options.confirmDelivery?.([...run.candidates.values()], run.contextMessages ?? [], ctx);
        // onResponse means headers received, before consuming the stream. It
        // confirms this request was accepted; it does not claim model completion.
        run.confirmedProjection = run.requestProjection;
        run.confirmed = true;
        run.requestPending = false;
        if (run.entry) gate.release(run.entry);
      } catch (error) {
        if (!run.signal.aborted && piRun === run && generation === run.generation) { ctx.abort?.(); throw error; }
      }
    });
    host.on("turn_end", (event, ctx) => {
      const run = piRun;
      if (!run || event.outcome !== "completed" || !run.confirmedProjection || run.signal.aborted) return;
      try {
        assertPiRun(run, ctx);
        acknowledgeProjection(run, event.context.contextEntries);
        const delivered = run.confirmedProjection;
        if (delivered.count <= run.persisted || !run.userEntryId
          || !event.context.contextEntries.some(entry => entry.sourceEntry.id === event.messageEntryId)) return;
        const projected = deferredSourceEntries(event.context.contextEntries, run.userEntryId, delivered.messages);
        if (!projected) return;
        run.pendingPersistence = { count: delivered.count, nativePromptSha256: projected.nativePromptSha256 };
        // Keep other extensions' drafts, without changing continuation or native
        // assistant/tool ordering. Pi applies the content edit and proof together.
        return { entries: [...event.entries, ...projected.entries] };
      } catch (error) {
        if (!run.signal.aborted && piRun === run && generation === run.generation) { ctx.abort?.(); throw error; }
      }
    });
  }
  host.on("input", async (event, ctx) => {
    const text = event.text ?? "";
    const current = gate.active;
    if (current) {
      if (current.phase === "dispatching" && event.source === "extension" && !current.forwarded && handoff?.entry === current && handoff.prompts.includes(text)) {
        try { gate.assertCurrent(current, ctx); current.forwarded = true; return adapter.continuedInput; }
        catch { ctx.abort?.(); return adapter.handledInput; }
      }
      if (event.source !== "interactive" && event.source !== "rpc") return adapter.continuedInput;
      ctx.ui?.setEditorText?.(text);
      return adapter.handledInput;
    }
    // Only the host input boundary grants invocation authority. Extension messages
    // and before-agent bootstrap text are context unless they match our handoff.
    if (event.source !== "interactive" && event.source !== "rpc") return adapter.continuedInput;
    // A known native choice belongs to the observation visible at acceptance.
    // A directory arriving during preparation must not retarget its name.
    ctx = options.librarySelection?.accept(ctx) ?? ctx;
    // Synchronous ownership closes the second-Enter gap before this hook's first await.
    acceptedContext = ctx;
    const entry = needsPreparation(text) || options.librarySelection && hasEnabledNotionSource(options.config) ? beginPreparation(event, ctx) : undefined;
    const submissionSignal = entry?.controller.signal ?? lifecycleController.signal;
    const submissionGeneration = generation;
    try {
      // Only local config selection is awaited here. Remote root verification
      // remains owned by discovery/consumption after this admission boundary.
      await options.librarySelection?.identity(ctx).catch(() => undefined);
      checkPreparationSignal(submissionSignal);
      if (entry) gate.assertCurrent(entry, ctx);
      const native = deferredPiDiscovery ? nativeRecord(text) : undefined;
      const selectedNative = native && visibleInLibrary(native, ctx) ? native : undefined;
      if (deferredPiDiscovery) {
        if (!entry) return adapter.continuedInput;
        // Pi expands /skill before it creates an agent operation. Keep the raw
        // input and images in our receipt, and suppress that uncancellable read.
        const submitted = text.startsWith("/skill:") ? "\n" + text : text;
        entry.phase = "dispatching";
        handoff = { entry, prompts: [text, submitted], consumed: false, selectedNative };
        return submitted === text ? adapter.continuedInput : adapter.transformInput(submitted, event.images);
      }
      // Cold preparation belongs to the registered command, outside the input hook budget.
      if (entry && adapter.submission.mode === "command") return adapter.transformInput(`/context-broker-submit ${entry.id}`);
      await preflight(text, ctx, submissionSignal, selectedNative);
      checkPreparationSignal(submissionSignal);
      if (submissionGeneration !== generation) throw preparationCancelled();
      if (entry) gate.assertCurrent(entry, ctx);
      const record = adapter.submission.mode === "transform" && text.startsWith("/skill:") ? selectedNative ?? nativeRecord(text) : undefined;
      if (record) {
        const prepared = await prepare(record, ctx, entry?.controller.signal);
        const snapshot = prepared.status === "ready" ? prepared.record : undefined;
        let args = /^\/skill:[^\s]+(?:\s+([\s\S]*))?$/.exec(text)?.[1]?.trim() ?? "";
        if (!snapshot) {
          const unavailable = [{ record, query: text.split(/\s/, 1)[0] ?? text }];
          notifyUnavailableReferences(ctx, unavailable);
          const submitted = (await options.taskPrompt?.(text, ctx, entry?.controller.signal, entry) ?? text) + "\n\n" + renderUnavailableReferences(unavailable);
          if (entry) gate.assertCurrent(entry, ctx);
          if (entry) { entry.phase = "dispatching"; handoff = { entry, prompts: [text, submitted], consumed: false }; }
          return adapter.transformInput(submitted, event.images);
        }
        args = await options.taskPrompt?.(args, ctx, entry?.controller.signal, entry) ?? args;
        if (entry) gate.assertCurrent(entry, ctx);
        if (options.isLoaded?.(snapshot, ctx)) {
          const submitted = `Use the already loaded Skill ${hostSkillName(snapshot)}.${args ? `\n\n${args}` : ""}`;
          if (entry) {
            entry.phase = "dispatching";
            handoff = { entry, prompts: [submitted], consumed: false };
          }
          return adapter.transformInput(submitted, event.images);
        }
        const expanded = await adapter.buildPrompt(snapshot, args, text, record);
        checkPreparationSignal(entry?.controller.signal);
        if (adapter.submission.receipt === "input-digest") nativeInputs.set(createHash("sha256").update(expanded).digest("hex"), snapshot);
        if (entry) { entry.phase = "dispatching"; handoff = { entry, prompts: [text, expanded], consumed: false }; }
        return adapter.transformInput(expanded, event.images);
      }
      if (entry) {
        const submitted = await options.taskPrompt?.(text, ctx, entry.controller.signal, entry) ?? text;
        gate.assertCurrent(entry, ctx);
        entry.phase = "dispatching";
        handoff = { entry, prompts: [text, submitted], consumed: false };
        if (submitted !== text) return adapter.transformInput(submitted, event.images);
      }
    } catch (error) {
      const current = !submissionSignal.aborted && submissionGeneration === generation;
      const restore = current && (!entry || gate.active === entry);
      if (entry) gate.release(entry);
      // Session replacement revokes ctx. Settle the old input without accessing
      // its UI/session getters or aborting the new session.
      if (restore) { ctx.ui?.setEditorText?.(text); notify(ctx, error); }
      return adapter.handledInput;
    }
    return adapter.continuedInput;
  });
  host.on("before_agent_start", async (event, ctx) => {
    ctx = turnContext(ctx);
    // before_agent_start has no input provenance; only a matching current receipt
    // may activate content. Delegated/bootstrap text is passed through unchanged.
    const beforeSignal = lifecycleController.signal, beforeGeneration = generation;
    try {
      if (!deferredPiDiscovery) await ready(beforeSignal);
      checkPreparationSignal(beforeSignal);
    }
    catch (error) { if (!beforeSignal.aborted && beforeGeneration === generation) { ctx.abort?.(); notify(ctx, error); } return undefined; }
    const receipt = handoff;
    const matches = receipt?.prompts.includes(event.prompt ?? "");
    try {
      if (receipt && matches) {
        gate.assertCurrent(receipt.entry, ctx);
        // Preflight and task expansion already own this submission's fixed snapshots.
        gate.assertCurrent(receipt.entry, ctx);
        receipt.consumed = true;
      }
    } catch (error) {
      const current = !beforeSignal.aborted && beforeGeneration === generation;
      if (receipt && matches) receipt.entry.controller.abort();
      if (current && (!gate.active || gate.active === receipt?.entry)) ctx.abort?.();
      // Keep the sole receipt until the final injection consumer acknowledges it.
      if (current) notify(ctx, error);
      return undefined;
    }
    const promptHash = createHash("sha256").update(event.prompt ?? "").digest("hex");
    const native = adapter.submission.receipt === "handoff"
      ? receipt && matches && receipt.native?.promptSha256 === promptHash ? receipt.native.snapshot : undefined
      : nativeInputs.get(promptHash);
    if (native && receipt && matches) receipt.native = { snapshot: native, promptSha256: promptHash };
    const message = native ? {
      customType: "context-broker", content: [], display: false,
      details: { nativePromptSha256: promptHash, records: [sourceDeliveryReceipt(native, event.prompt ?? "")].filter(Boolean) },
    } : undefined;
    if (native && adapter.submission.receipt === "input-digest") nativeInputs.delete(promptHash);
    // Pi preparation runs later in context. A forced prompt here would freeze
    // pending metadata and override its final context_with_system projection.
    if (deferredPiDiscovery) return message ? { message } : undefined;
    const systemPrompt = catalogSystemPrompt(event.systemPrompt, ctx);
    return { ...(message ? { message } : {}), systemPrompt: adapter.systemPrompt?.(systemPrompt) ?? systemPrompt };
  });
  function catalogSystemPrompt(input: string | string[] | undefined, ctx: ExtensionContext,
    candidateRefs = modelCandidateReferences([...records, ...defaultRouters].filter(record => available(record) && visibleInLibrary(record, ctx)), ctx), omitDescription?: (record: SkillRecord) => boolean): string {
    let systemPrompt = viewSystemPrompt(input, records.filter(record => available(record) && visibleInLibrary(record, ctx)), defaultRouters.filter(record => available(record) && visibleInLibrary(record, ctx)), new Set(readRecords.keys()), views.filter(view => !options.librarySelection || view.sourceId === libraryContext(ctx)?.peek()?.source.id), ctx.cwd,
      record => candidateRefs.get(record), listToolName, piConsumption, omitDescription);
    if (deferredPiDiscovery) {
      if (metadataPending || discoveryError || options.librarySelection && !libraryContext(ctx)?.peek() || sourceFailures.some(failure => failure.blocking !== false)) {
        const state = metadataPending ? "pending" : "unavailable";
        systemPrompt += `\n\n<ntn-skills-discovery status="${state}">Notion metadata is ${state}; this does not mean the directory is empty. Use ${listToolName} when the task needs discovery. It reports source failures. Visible entries may come from a previous observation. Previously loaded instructions keep their selected versions.</ntn-skills-discovery>`;
      }
    }
    return systemPrompt;
  }
  if (deferredPiDiscovery) host.on("context_with_system", (event, ctx) => {
    ctx = turnContext(ctx);
    if (event.messages[0]?.role !== "system" || lifecycleController.signal.aborted || piRun?.signal.aborted) return undefined;
    // Render only metadata already observed by the cancellable context boundary.
    const candidateRefs = modelCandidateReferences([...records, ...defaultRouters].filter(record => available(record) && visibleInLibrary(record, ctx)), ctx);
    let branch: ReturnType<typeof reduceSessionShortRefs> | undefined;
    try { branch = reduceSessionShortRefs(ctx.sessionManager?.getBranch?.() ?? []); }
    catch { /* Unverifiable branch references cannot justify omitting metadata. */ }
    const defaultCard = (record: SkillRecord): CatalogDescription | undefined => {
      const ref = candidateRefs.get(record);
      return record.source === "notion" && ref && record.sourceId && record.sourceScope && record.kind
        ? { ref, source: record.sourceId, scope: record.sourceScope, kind: record.kind, name: record.name,
          description: record.description, availability: available(record) ? "available" : "disabled" } : undefined;
    };
    const identify = (card: CatalogDescription, canonical?: { id: string; ref: string }): string | undefined => {
        if (!branch || card.availability !== "available") return undefined;
        try {
          const target = resolveSessionShortRef(branch, card.ref, card.scope);
          if (target.kind !== "candidate") return undefined;
          const record = hostRecords.get(JSON.stringify([card.source, card.scope, card.kind, target.identity.locator.type, target.identity.id]));
          if (!record || !matchesShortRefSource(target.identity, record) || record.enabled === false
            || record.kind !== card.kind || record.name !== card.name || record.description !== card.description) return undefined;
          if (canonical) {
            const reference = parseNativeReference(canonical.ref);
            if (canonical.id !== target.identity.id || reference.snapshot !== undefined
              || reference.selector !== parseNativeReference(target.canonicalRef).selector || reference.path !== record.entrypoint) return undefined;
          }
          return JSON.stringify([card.source, target.identity, card.ref, card.name, card.description, card.availability]);
        } catch { return undefined; }
    };
    // The context hook removes receipt-only messages. Reattach the current
    // native receipts for validation, then omit these appended messages below.
    const section = "context-broker-notion-catalog";
    const visible = event.messages.filter(message => message.role !== "custom" || message.customType !== section);
    const messages = withSessionSourceReceipts(visible, ctx.sessionManager?.buildSessionProjection?.().entries ?? []);
    const projected = projectCatalogDescriptions({ messages,
      defaults: [...records, ...defaultRouters].filter(record => available(record) && visibleInLibrary(record, ctx)).flatMap(record => { const card = defaultCard(record); return card ? [card] : []; }),
      identify,
      matchesRead(ref, binding, identity) {
        if (!branch) return false;
        try {
          const record = hostRecords.get(identity);
          const target = resolveSessionShortRef(branch, ref, binding.scope);
          return record !== undefined && target.kind === "selected" && matchesShortRefSource(target.selection.identity, record)
            && isDeepStrictEqual(target.selection.identity.locator, binding.record.locator)
            && target.selection.identity.id === binding.record.id
            && target.selection.identity.kind === binding.record.kind
            && target.selection.ref === binding.ref && target.selection.snapshot_id === binding.snapshot_id
            && target.selection.version_id === binding.version_id && target.selection.body_sha256 === binding.body_sha256;
        } catch { return false; }
      },
    });
    const catalog = catalogSystemPrompt("", ctx, candidateRefs, record => {
      const card = defaultCard(record), key = card && identify(card);
      return key !== undefined && projected.omittedDefaults.has(key);
    }).trimStart();
    const ownedPaths = new Set(readRecords.keys());
    const clean = (text: string) => withoutViewMetadata(text, ownedPaths, ctx.cwd);
    const cleaned = projected.messages.slice(0, visible.length).map(message => {
      if (message.role !== "system") return message;
      const content = typeof message.content === "string" ? clean(message.content)
        : message.content?.map(part => part.type === "text" ? { ...part, text: clean(part.text) } : part);
      const sections = Object.fromEntries(Object.entries(message.sections ?? {}).filter(([name]) => name !== section)
        .map(([name, value]) => [name, value === null ? null : clean(value)]));
      return { ...message, content, ...(message.sections || Object.keys(sections).length ? { sections } : {}) };
    });
    // Pi may honor another extension's exact system prompt after this hook.
    // Keep directory data outside that prompt, without persisting another body.
    const finalMessages = cleaned.flatMap((message, index): AgentMessage[] => index === 0 && catalog
      ? [message, { role: "custom", customType: section, content: catalog, display: false, timestamp: 0 }]
      : [message]);
    if (piRun) {
      const receipts = (piRun.contextMessages ?? []).filter(message => message.role === "custom"
        && message.customType === "context-broker" && !sourceMessageText(message.content)
        && message.details && typeof message.details === "object" && "nativePromptSha256" in message.details);
      const users = new Set(finalMessages.filter(message => message.role === "user")
        .map(message => createHash("sha256").update(sourceMessageText(message.content)).digest("hex")));
      for (const receipt of receipts) {
        if (!users.has(String(Reflect.get(receipt.details!, "nativePromptSha256")))) {
          ctx.abort?.(); throw hostError("SOURCE_FINAL_PROJECTION_INVALID");
        }
      }
      // The original receipt remains private. Later mutable hooks cannot change
      // the expected user role/text by mutating the returned message objects.
      piRun.finalMessages = structuredClone([...finalMessages, ...receipts]);
    }
    return { messages: finalMessages };
  });
  type ExactRecordLookup = { status: "found"; record: SkillRecord }
    | { status: "missing"; scopes: ReadonlyMap<string, ReadonlySet<string>>;
      failures: readonly SourceFailure[]; lists: readonly NotionListObservation[]; failure: SourceFailure | undefined };
  async function lookupExactRecord(reference: ExactNativeReference, ctx: ExtensionContext, signal: AbortSignal, short?: HostShortRefResolution, resolved?: SkillRecord): Promise<ExactRecordLookup> {
    const selector = reference.selector;
    const matches = (record: SkillRecord) => record.ref?.startsWith("skill://") && parseNativeReference(record.ref).selector === selector
      && (!short || matchesShortRefSource(short.assertion, record));
    let candidates = (resolved ? [resolved] : [...hostRecords.values()]).filter(matches);
    if (resolved && !candidates.length) throw hostError("SOURCE_IDENTITY_MISMATCH");
    let lookupFailures: readonly SourceFailure[] = [], lookupLists: readonly NotionListObservation[] = [];
    let missingFailure: SourceFailure | undefined;
    const lookupScopes = new Map<string, Set<string>>();
    if (!candidates.length && options.lookupReference) {
      const observedGeneration = generation;
      const fresh = await options.lookupReference(ctx, signal);
      checkPreparationSignal(signal);
      if (observedGeneration !== generation) throw preparationCancelled();
      lookupFailures = fresh.failures; lookupLists = fresh.lists ?? [];
      const observeScope = (sourceId: string, scope: string) => {
        const scopes = lookupScopes.get(sourceId) ?? new Set<string>();
        scopes.add(scope); lookupScopes.set(sourceId, scopes);
      };
      for (const list of fresh.lists ?? []) if (list.scope) observeScope(list.sourceId, list.scope);
      for (const record of fresh.records) if (record.sourceId && record.sourceScope) observeScope(record.sourceId, record.sourceScope);
      candidates = fresh.records.filter(record => record.source === "notion" && matches(record));
      if (!candidates.length) missingFailure = fresh.failures.find(item => item.blocking !== false);
    }
    // Without an independent lookup, failed discovery cannot establish absence.
    if (!candidates.length && !options.lookupReference && discoveryError) throw discoveryError;
    const active = gate.active?.prepared ?? (turnPrompts?.signal.aborted ? undefined : turnPrompts?.snapshots);
    const scopes = [...(active?.values() ?? [])].filter(record => record.sourceScope !== undefined);
    if (!short && scopes.length) candidates = candidates.filter(record => scopes.some(scope => scope.sourceId === record.sourceId && scope.sourceScope === record.sourceScope));
    if (candidates.length > 1) throw new InvocationError(selector, "ambiguous", candidates);
    const selected = candidates[0];
    if (!selected) return { status: "missing", scopes: lookupScopes, failures: lookupFailures, lists: lookupLists, failure: missingFailure };
    // A canonical selector is an identity, not a source namespace prefix.
    // Unrelated directory failures do not veto this exact owner; its own
    // recorded failure and the normal source read/prepare checks still apply.
    assertRecordSourceAvailable(selected);
    assertRecordSourceAvailable(selected, lookupFailures);
    if (short) assertShortRefSource(short, selected);
    hostRecords.set(recordIdentity(selected), selected);
    return { status: "found", record: selected };
  }
  function missingExactRecord(failure?: SourceFailure): never {
    if (failure) throw new SourceError(failure.code, failure.sourceId);
    throw hostError("SOURCE_REFERENCE_MISSING");
  }
  async function exactRecord(reference: ExactNativeReference, ctx: ExtensionContext, signal: AbortSignal, short?: HostShortRefResolution, resolved?: SkillRecord): Promise<SkillRecord> {
    const found = await lookupExactRecord(reference, ctx, signal, short, resolved);
    if (found.status === "missing") return missingExactRecord(found.failure);
    return found.record;
  }
  function hasExactFixedReference(record: SkillRecord, reference: ExactNativeReference): boolean {
    const refs = [record.preparationBinding?.ref, ...(record.entryManifest?.manifest_complete ? record.entryManifest.files.map(file => file.ref) : [])];
    return refs.some(ref => ref !== undefined && isDeepStrictEqual(parseNativeReference(ref), reference));
  }
  function confirmedFixedReadRecord(reference: ExactNativeReference, ctx: ExtensionContext, observedScopes: ReadonlyMap<string, ReadonlySet<string>>, short?: HostShortRefResolution): SkillRecord | undefined {
    if (!reference.snapshot || !reference.path || short?.kind === "candidate") return undefined;
    const selection = sessionSelection(ctx);
    const matches = [...activeSources(ctx).sources.values()].map(source => source.record).filter(record => {
      const binding = record.preparationBinding;
      const selected = record.sourceScope && record.id ? selection.scopes.get(record.sourceScope)?.bindings.get(record.id) : undefined;
      if (record.source !== "notion" || !record.sourceId || !binding || !selected || !samePreparationBinding(selected, binding)
        || short && !matchesShortRefSource(short.assertion, record)) return false;
      return hasExactFixedReference(record, reference);
    });
    if (matches.length !== 1) return undefined;
    const record = matches[0]!;
    // A current branch's exact selected + confirmed delivery locates historical
    // bytes; it does not renew source authorization or revive a released root.
    const source = options.config.sources?.find(source => source.id === record.sourceId && source.type === "notion" && source.enabled !== false);
    if (!source) throw new SourceError("SOURCE_UNAVAILABLE", record.sourceId!);
    const currentScope = catalogScopes.get(JSON.stringify([source.id, record.locator?.type === "shared_skill" ? record.locator.library_id : undefined])), freshScopes = observedScopes.get(source.id);
    if (currentScope !== record.sourceScope) throw new SourceError(currentScope ? "SOURCE_IDENTITY_MISMATCH" : "SOURCE_UNAVAILABLE", source.id);
    if (freshScopes && (freshScopes.size !== 1 || !freshScopes.has(record.sourceScope!))) throw new SourceError("SOURCE_IDENTITY_MISMATCH", source.id);
    if (short) assertShortRefSnapshot(short, record);
    return record;
  }
  async function exactReadRecord(reference: ExactNativeReference, ctx: ExtensionContext, signal: AbortSignal,
    short?: HostShortRefResolution, resolved?: SkillRecord): Promise<{ record: SkillRecord; routing: "directory" | "confirmed-fixed" }> {
    const ticket = observations.begin(signal);
    const found = await lookupExactRecord(reference, ctx, signal, short, resolved);
    if (found.status === "found") return { record: found.record, routing: "directory" };
    checkPreparationSignal(signal);
    const record = confirmedFixedReadRecord(reference, ctx, found.scopes, short);
    if (!record) return missingExactRecord(found.failure);
    const authentication = found.failures.find(failure => failure.sourceId === record.sourceId && failure.blocking !== false && failure.code === "AUTH_REQUIRED");
    if (authentication) observeFailure(new SourceError(authentication.code, authentication.sourceId), ticket, [record], undefined, ctx);
    assertRecordSourceAvailable(record, found.failures);
    assertCanRestore(record);
    // A separate source's failed discovery cannot veto an exact owner whose
    // own lookup completed with the same scope. No list proof means no bypass.
    if (found.failure && !found.lists.some(list => list.sourceId === record.sourceId && list.scope === record.sourceScope
      && list.policy !== "offline" && list.policy !== "pinned" && list.stale !== true)) return missingExactRecord(found.failure);
    return { record, routing: "confirmed-fixed" };
  }
  function modelFiles(record: SkillRecord, ctx: ExtensionContext) {
    const files = record.preparationDirectory?.files;
    if (!files || adapter.paths.host !== "pi" || record.source !== "notion" || !shortRefs.canBind(ctx)) return files;
    return files.map(file => ({ ...file, ref: file.path === record.entrypoint
      ? shortRefs.selected(ctx, record) : record.entryManifest?.manifest_complete ? shortRefs.resource(ctx, record, file.ref) : file.ref }));
  }
  function modelDirectory(record: SkillRecord, prepared: readonly SkillRecord[], ctx: ExtensionContext) {
    const directory = record.preparationDirectory;
    if (!directory || adapter.paths.host !== "pi" || record.source !== "notion" || !shortRefs.canBind(ctx)) return directory;
    const related = (entry: typeof directory.required[number]) => {
      const fixed = prepared.find(value => value.id === entry.id && value.sourceScope === record.sourceScope);
      const candidates = fixed ? [fixed] : [...hostRecords.values()].filter(value => value.id === entry.id
        && value.sourceScope === record.sourceScope && value.sourceId === record.sourceId);
      const target = candidates.length === 1 ? candidates[0] : undefined;
      if (!target?.ref) return entry;
      let reference: ExactNativeReference;
      try { reference = parseNativeReference(entry.ref); }
      catch { return entry; }
      if (reference.selector !== parseNativeReference(target.ref).selector) return entry;
      if (reference.snapshot !== undefined) {
        // A fixed relation may name an older version or a resource. It must never
        // be replaced with the current main entry merely because the owner ID matches.
        if (!fixed?.preparationBinding || reference.snapshot !== fixed.snapshotId) return entry;
        if (!reference.path || reference.path === fixed.entrypoint)
          return { ...entry, ref: shortRefs.selected(ctx, fixed) };
        const file = fixed.entryManifest?.files.find(file => file.path === reference.path);
        return file ? { ...entry, ref: shortRefs.resource(ctx, fixed, file.ref) } : entry;
      }
      if (reference.path && reference.path !== target.entrypoint) return entry;
      return { ...entry, ref: modelReference(target, ctx) ?? entry.ref };
    };
    return { files: modelFiles(record, ctx)!,
      required: directory.required.map(related), candidates: directory.candidates.map(related), references: directory.references.map(related) };
  }
  if (sourceToolsEnabled && options.prepareGraph) host.registerTool?.({
    name: useToolName, label: piConsumption ? "Use Notion Skills" : "Prepare Skills",
    description: piConsumption
      ? "Load task roots directly to apply their instructions; no preliminary read is needed. Requires load automatically: do not add them as independent roots unless independently requested. To introduce, summarize or inspect a Skill, use read instead. Copy a supplied ref, or pass task roots together. Use refresh:true only for a requested update; the supplied current or fixed main ref locates the same owner's latest version. Refresh roots with conflicting shared Requires together. Members remain candidates. Loading does not authorize executing a workflow. Notion consumption does not write to Notion."
      : "Prepare exact Skill roots. Use purpose use to load complete root and Required instructions before executing a workflow; inspect reads only roots and does not activate their dependencies. Members and ordinary references remain directories.",
    parameters: piConsumption ? { type: "object", properties: {
      ref: { anyOf: [{ type: "string" }, { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } }], description: "Supplied sr:C/sr:S or skill://<stable-skill-id>[/<main>][?library=<root-page-uuid>] refs, or exact Notion Skill page URLs for task roots. Requires are included automatically. Copy returned canonical refs; names and aliases are discovery labels." },
      refresh: { type: "boolean", description: "Explicitly adopt current versions for only these roots after a complete successful load. Existing Requires-only nodes cannot become independent roots through refresh; explicitly use them without refresh first. Accepts the supplied sr:C/sr:S or main ref unchanged, for example {ref:[REF_A,REF_B],refresh:true} for shared roots. Failure keeps the previous selection." },
    }, required: ["ref"], additionalProperties: false } : { type: "object", properties: {
      roots: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" }, description: "Copy exact session sr:C/sr:S references or canonical skill:// main-entry references from metadata or a previous result." },
      purpose: { type: "string", enum: ["use", "inspect"], description: "Explicit operation intent; inspection does not authorize workflow execution." },
      refresh: { type: "boolean", description: "Fetch current versions from the supplied main refs. Use adopts only these roots after successful preparation; inspect leaves existing pins unchanged. Refresh shared-conflicting roots together. Failure keeps the previous selection." },
      readOnly: { type: "boolean", description: "Forbid remote writes, including history retention." },
    }, required: ["roots", "purpose"], additionalProperties: false },
    strict: true, readsSkillUris: true, loadMode: "essential", approval: () => "read", approvalCacheTargets: () => undefined,
    sourcePath: import.meta.url, defaultInactive: false,
    ...(piConsumption ? { exposure: "model-only" as const, defaultActive: true } : {}),
    async execute(id, input, signal, _onUpdate, ctx) {
      ctx = turnContext(ctx);
      const observedEffects: ConsumptionEffects[] = [];
      let acquiring = false;
      try {
      const combined = signal ? AbortSignal.any([signal, lifecycleController.signal]) : lifecycleController.signal;
      const requested = piConsumption ? typeof input.ref === "string" ? [input.ref] : input.ref : input.roots;
      if ((!piConsumption && !["use", "inspect"].includes(String(input.purpose))) || !Array.isArray(requested) || !requested.length || requested.length > 64
        || requested.some(value => typeof value !== "string") || input.refresh !== undefined && typeof input.refresh !== "boolean"
        || input.readOnly !== undefined && typeof input.readOnly !== "boolean"
        || Object.keys(input).some(key => !(piConsumption ? ["ref", "refresh"] : ["roots", "purpose", "refresh", "readOnly"]).includes(key))) throw hostError("INVALID_ARGUMENT");
      const references = requested.map(raw => resolveReference(String(raw), ctx));
      for (const { short } of references) if (short?.kind === "resource") throw hostError("PREPARE_ROOT_NOT_MAIN");
      checkPreparationSignal(combined);
      if (input.refresh === true && (piConsumption || input.purpose === "use")) assertRefreshRootRoles(references, ctx);
      await ready(combined);
      const inputs: ResolvedHostReference[] = [];
      for (const raw of requested) inputs.push(await resolveToolReference(String(raw), ctx, combined, input.refresh === true));
      if (input.refresh === true && (piConsumption || input.purpose === "use")) assertRefreshRootRoles(inputs, ctx);
      const roots: SkillRecord[] = [], pins = new Map<string, string>(), resolved: ResolvedHostReference[] = [];
      for (let value of inputs) {
        let record = await exactRecord(value.reference, ctx, combined, value.short, value.record);
        if (input.refresh === true && (piConsumption || input.purpose === "use")) assertRefreshRootRoles([{ ...value, record }], ctx);
        const main = value.short?.kind === "selected" ? value.short.selection.entrypoint : record.entrypoint;
        if (input.refresh === true) {
          assertRefreshMain(value.reference, record, ctx, value.short);
          value = await currentRoot(record, ctx, combined); record = value.record!;
        } else if (value.reference.path && value.reference.path !== main || record.kind === "prompt") throw hostError("PREPARE_ROOT_NOT_MAIN");
        if (value.reference.snapshot && record.id) {
          if (pins.has(record.id) && pins.get(record.id) !== value.reference.snapshot) throw hostError("SOURCE_SESSION_CONFLICT");
          pins.set(record.id, value.reference.snapshot);
        }
        resolved.push(value);
        roots.push(record);
      }
      const purpose = piConsumption || input.purpose === "use" ? "use" : "inspect";
      acquiring = true;
      const prepared = await graphPreparation(roots, ctx, combined, purpose, pins, input.refresh === true ? "replace" : "extend", false,
        { readOnly: piConsumption || input.readOnly === true, observeEffects: effects => observedEffects.push(effects) });
      const effects = combineConsumptionEffects(prepared.graphs.map(graph => graph.effects));
      observedEffects.push(effects);
      for (let index = 0; index < requested.length; index++) {
        const { reference, short } = resolved[index]!;
        const record = prepared.records.find(record => recordIdentity(record) === recordIdentity(roots[index]!));
        if (!record || nativeResourcePath(reference, record) !== record.entrypoint) throw hostError("PREPARE_ROOT_NOT_MAIN");
        if (short) assertShortRefSnapshot(short, record);
      }
      const unique = [...new Map(prepared.records.map(record => [JSON.stringify([record.sourceScope, record.id]), record])).values()];
      const graphs = prepared.graphs.map(graph => ({ scope: graph.scope, roots: graph.roots, graph_lock: graph.lock, budget: graph.budget, usage: graph.usage }));
      const compilation = adapter.paths.host === "pi" ? (() => {
        const records = unique.map(record => ({
          name: record.name, kind: record.kind ?? "skill", ref: modelReference(record, ctx, true) ?? record.preparationBinding!.ref,
          content: record.body!, source: { identity: recordIdentity(record), sha256: record.preparationBinding!.body_sha256, bytes: Buffer.byteLength(record.body!) },
          directory: modelDirectory(record, unique, ctx),
        }));
        const selected = roots.map(root => unique.findIndex(record => record.sourceScope === root.sourceScope && record.id === root.id));
        if (selected.some(index => index < 0)) throw hostError("SOURCE_PREPARATION_INVALID");
        return compileSkillPreparation({ purpose, roots: [...new Set(selected.map(index => records[index]!.ref))], records, effects });
      })() : undefined;
      const legacy = compilation ? undefined : {
        ok: true, status: "ready", purpose, effects,
        graphs,
        records: unique.map(record => {
          const ref = modelReference(record, ctx, true);
          return {
          id: record.id, scope: record.sourceScope, ref: ref ?? record.preparationBinding!.ref, snapshot_id: record.snapshotId,
          version_id: record.versionId, body_sha256: record.preparationBinding!.body_sha256, bytes: Buffer.byteLength(record.body!),
          content: record.body!, ...(ref ? {} : { path: record.path }), directory: modelDirectory(record, unique, ctx),
          ...(record.entryManifest ? { materialization: publicEntryMaterialization(record) } : {}),
        }; }),
      };
      const content = compilation?.content ?? JSON.stringify(legacy);
      if (Buffer.byteLength(content) > Math.min(...prepared.graphs.map(graph => graph.budget.maxContextBytes))) throw hostError("PREPARE_CONTEXT_BUDGET");
      checkPreparationSignal(combined);
      let recordOffset = compilation ? 0 : content.indexOf('"records":[');
      const receipts = unique.map((record, index) => {
        let start: number;
        if (compilation) start = compilation.bodySpans[index]!.start;
        else {
          const serialized = JSON.stringify(legacy!.records[index]);
          recordOffset = content.indexOf(serialized, recordOffset);
          start = recordOffset + serialized.indexOf('"content":' + JSON.stringify(record.body)) + '"content":"'.length;
          recordOffset += serialized.length;
        }
        const delivered = sourceDeliveryReceipt(record, content, "json", start);
        if (!delivered) throw hostError("SOURCE_PREPARATION_INVALID");
        const proof = purpose === "inspect" && input.refresh === true ? { ...delivered, purpose: "inspect" as const } : delivered;
        return compilation ? { ...proof, directory: record.preparationDirectory,
          ...(record.entryManifest ? { materialization: publicEntryMaterialization(record) } : {}) } : proof;
      });
      checkPreparationSignal(combined);
      prepared.commit();
      return {
        content: [{ type: "text", text: content }],
        details: { contextBrokerPreparation: { version: compilation ? 2 : 1, toolCallId: id, purpose,
          records: receipts, graphs, effects, ...(compilation ? { projection: compilation.projection } : {}) } },
      };
      } catch (error) {
        if (!acquiring) throw error;
        const effects = combineConsumptionEffects([...observedEffects, errorConsumptionEffects(error)]);
        const diagnostic = error instanceof SourceError ? sourceFailureDiagnostic(error.code, error.details) : undefined;
        const diagnostics = error !== null && typeof error === "object" && "code" in error && error.code === "SOURCE_SESSION_CONFLICT" && "details" in error
          ? preparationFailureDetails(error.details) : undefined;
        const conflict = diagnostics ? { ...diagnostics, ...(Array.isArray(diagnostics.roots) ? { roots: diagnostics.roots.map(root => {
          const records = [...hostRecords.values()].filter(record => record.sourceScope === root.scope && record.id === root.id);
          const record = records.length === 1 ? records[0] : undefined;
          return { ...root, ...(record ? { ref: modelReference(record, ctx) ?? record.ref } : {}) };
        }) } : {}) } : undefined;
        const message = JSON.stringify({ ok: false, status: signal?.aborted ? "cancelled" : "failed", error: failure(error), effects,
          ...(diagnostic ? { diagnostic } : {}),
          ...(conflict ? { conflict } : {}),
          ...(error instanceof WorkingSetBudgetError ? { working_set: error.details.working_set } : {}) });
        throw consumptionFailure(error, message, effects);
      }
    },
  });
  if (sourceToolsEnabled && options.sessionGraph) host.registerTool?.({
    name: controlToolName, label: piConsumption ? "Notion management" : "Selected Skill graph",
    description: "Inspect this branch's Skill graph or working_set. working_set show lists confirmed roots, Requires, visible instruction bytes and the session budget; budget explicitly sets max_bytes, null disables it; release retires only the supplied fixed roots and preserves shared Requires, Session history and Notion. Alternatively request cli_source for one exact configured Notion source's host-local CLI prefix when an authorized maintenance/source task needs it. These operations do not execute CLI commands or grant authorization. Choose only one operation.",
    parameters: { type: "object", properties: {
      refs: { type: "array", maxItems: 64, items: { type: "string" }, description: "Optional fixed sr:S/sr:R references to export as canonical identity and exact version proofs for independent validation." },
      cli_source: { type: ["string", "null"], minLength: 1, description: "Use null for this accepted turn’s Library, or an exact enabled Notion source ID to choose another write target. Returns the verified root scope and host-local command prefix without execution." },
      working_set: { type: "string", enum: ["show", "budget", "release"], description: "Inspect, explicitly budget, or release this session's Notion root/Requires working set. No remote writes or historical deletion." },
      roots: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" }, description: "For release only. Copy fixed root refs from working_set show or selected sr:S refs. Required-only nodes cannot be released directly." },
      // A literal null branch prevents the host's schema converter from
      // coercing an invalid numeric zero into a request to disable the budget.
      max_bytes: { anyOf: [{ type: "integer", minimum: 1 }, { enum: [null] }], description: "For budget only. Complete active instruction closure in UTF-8 bytes, not tokens. Explicit null disables the budget. No automatic eviction or truncation." },
    }, additionalProperties: false },
    strict: true, readsSkillUris: false, loadMode: piConsumption ? "discoverable" : "essential", approval: () => "read", approvalCacheTargets: () => undefined,
    sourcePath: import.meta.url, defaultInactive: piConsumption,
    ...(piConsumption ? { exposure: "deferred" as const, defaultActive: false } : {}),
    async execute(_id, input, signal, _update, ctx) {
      ctx = turnContext(ctx);
      checkPreparationSignal(signal);
      if (Object.keys(input).some(key => !["refs", "cli_source", "working_set", "roots", "max_bytes"].includes(key)) || input.refs !== undefined && (!Array.isArray(input.refs) || input.refs.length > 64
        || input.refs.some(value => typeof value !== "string"))) throw hostError("INVALID_ARGUMENT");
      if (input.working_set !== undefined) {
        if (!piConsumption || !["show", "budget", "release"].includes(String(input.working_set)) || input.refs !== undefined || input.cli_source !== undefined) throw hostError("INVALID_ARGUMENT");
        let changed = false;
        if (input.working_set === "show") {
          if (input.roots !== undefined || input.max_bytes !== undefined) throw hostError("INVALID_ARGUMENT");
        } else if (input.working_set === "budget") {
          if (input.roots !== undefined || input.max_bytes !== null && typeof input.max_bytes !== "number") throw hostError("INVALID_ARGUMENT");
          changed = setWorkingSetBudget(host, ctx, input.max_bytes);
        } else {
          if (input.max_bytes !== undefined || !Array.isArray(input.roots) || input.roots.some(ref => typeof ref !== "string")) throw hostError("INVALID_ARGUMENT");
          const roots = input.roots.map(ref => {
            if (!isSessionShortRefInput(ref)) return ref;
            const resolved = shortRefs.resolve(ctx, ref);
            if (resolved.kind !== "selected") throw hostError("SOURCE_RELEASE_FIXED_ROOT_REQUIRED");
            return resolved.canonicalRef;
          });
          changed = releaseWorkingSetRoots(host, ctx, roots).changed;
          if (changed) {
            // Retire all acquisition generations before another asynchronous
            // result can publish the released selection. The current model
            // operation continues with a fresh projection on its next request.
            generation++;
            loaded.clear(); pendingNativeReads.clear(); pendingResourceReads.clear();
            const entry = gate.active;
            if (entry) { entry.prepared.clear(); preparedForUse.delete(entry); pendingGraphs.delete(entry); }
            if (piRun) {
              piRun.generation = generation; piRun.candidates.clear(); piRun.graphs = [];
              piRun.requestPending = false; piRun.confirmedProjection = undefined;
              if (piRun.entry) pendingGraphs.delete(piRun.entry);
            }
          }
        }
        const projection = ctx.sessionManager?.buildSessionProjection?.();
        const messages = withSessionSourceReceipts(projection?.messages ?? ctx.sessionManager?.buildSessionContext?.().messages ?? [], projection?.entries ?? []);
        const result = { ...exportWorkingSet(ctx, messages), action: input.working_set, changed };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      if (input.roots !== undefined || input.max_bytes !== undefined) throw hostError("INVALID_ARGUMENT");
      if (input.cli_source !== undefined) {
        if (input.cli_source !== null && (typeof input.cli_source !== "string" || !input.cli_source.length) || input.refs !== undefined) throw hostError("INVALID_ARGUMENT");
        const active = host.getActiveTools?.();
        if (!active?.includes("bash") || !piConsumption && !active.includes(controlToolName)) throw hostError("HOST_CLI_TOOL_UNAVAILABLE");
        const selected = input.cli_source === null ? await options.librarySelection?.selected(ctx) : undefined;
        const configured = input.cli_source === null ? selected ? [selected.source] : []
          : (options.config.sources ?? []).filter(source => source.type === "notion" && source.enabled !== false && source.id === input.cli_source);
        if (!configured.length) throw hostError("HOST_SOURCE_UNAVAILABLE");
        if (configured.length !== 1 || configured[0]!.type !== "notion") throw hostError("HOST_SOURCE_AMBIGUOUS");
        const source = configured[0];
        const library = selected?.library ?? (options.librarySelection ? await options.librarySelection.verify(source, ctx)
          : await resolveNotionLibrarySdk({ library: source.library, cwd: ctx.cwd, env: { ...process.env }, signal }));
        const sources = [{ ...source, library: library.library_id }];
        const result = { kind: "host_cli_scope", ...hostCliScope(sources), executed: false,
          execution: {
            default_cli_timeout_ms: 600_000,
            guidance: "The default CLI budget is 600 seconds; an explicit CLI --timeout is in milliseconds. "
              + "For authorized writes, give the host execution window that budget plus startup and completion margin. "
              + "If the tool cannot wait that long, use a persistent background job, keep its original Store and credential scope, "
              + "and await the same process's terminal result. A short polling timeout is not completion; do not kill or repeat the write just because a wait ended.",
          } };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      const graph = options.sessionGraph!(ctx);
      const result = Array.isArray(input.refs) ? { graph, references: input.refs.map(ref => shortRefs.export(ctx, ref)) } : graph;
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  function assertFixedOwnerBinding(actual: PreparationBinding, expected: PreparationBinding): void {
    if (!isDeepStrictEqual({ ...actual, ref: parseNativeReference(actual.ref) }, { ...expected, ref: parseNativeReference(expected.ref) }))
      throw hostError("SOURCE_IDENTITY_MISMATCH");
  }

  function resourceSelection(record: SkillRecord, reference: ExactNativeReference, ctx: ExtensionContext) {
    const manager = ctx.sessionManager;
    // Historical branch receipts may retain an inspection's exact directory
    // after compaction. They route reads only; every read rechecks permission.
    const messages = [...manager?.buildSessionContext?.().messages ?? [],
      ...manager?.getBranch?.().flatMap(entry => entry.type === "message" && entry.message ? [entry.message] : []) ?? []];
    const inspection = inspectedResource(messages, record, reference);
    if (!inspection) return { ...assertSourceSelection(record, ctx, reference.snapshot), inspection: undefined };
    if (gate.active) gate.assertCurrent(gate.active, ctx);
    assertCanRestore(record);
    return { snapshot: reference.snapshot, binding: inspection.binding, inspection };
  }

  function assertFixedResourceSnapshot(resource: Omit<FixedResourceRead, "file"> & { file: Omit<FixedResourceRead["file"], "output"> }, reference: ExactNativeReference, snapshot: SkillRecord): void {
    if (!snapshot.preparationBinding || !snapshot.entryManifest?.manifest_complete) throw hostError("SOURCE_PREPARATION_INVALID");
    assertFixedOwnerBinding(resource.ownerBinding, snapshot.preparationBinding);
    if (resource.selection.scope !== snapshot.sourceScope || resource.selection.owner !== snapshot.id || resource.selection.snapshot_id !== snapshot.snapshotId
      || resource.selection.version_id !== snapshot.versionId || resource.entrypoint !== snapshot.entrypoint) throw hostError("SOURCE_IDENTITY_MISMATCH");
    const path = nativeResourcePath(reference, snapshot), files = snapshot.entryManifest.files.filter(file => file.path === path);
    const expected = files[0], actual = resource.file, fileId = snapshot.fileBindings?.find(binding => binding.path === path)?.file_id;
    if (files.length !== 1 || !expected || actual.path !== path || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 || actual.file_id !== fileId
      || !isDeepStrictEqual(parseNativeReference(actual.ref), parseNativeReference(expected.ref))) throw hostError("SOURCE_IDENTITY_MISMATCH");
  }

  async function prepareFixedResourceRead(event: ToolCallEvent, ctx: ExtensionContext, signal: AbortSignal, record: SkillRecord,
    reference: ExactNativeReference, short?: HostShortRefResolution, requestedRef = event.input.path as string): Promise<PreparedReadResult | undefined> {
    if (adapter.paths.host !== "pi" || !options.readFixedResource || record.source !== "notion"
      || !reference.snapshot || !reference.path || short && short.kind !== "resource") return undefined;
    // Keep canonical main hints on the normal route so main reads do not first
    // fetch a speculative resource. That route also resolves their File IDs.
    if (!short && reference.path === (record.entrypoint ?? "SKILL.md")) return undefined;
    const observedGeneration = generation, owner = gate.active;
    const sessionId = ctx.sessionManager?.getSessionId?.(), sessionFile = ctx.sessionManager?.getSessionFile?.();
    let resource: FixedResourceRead | undefined;
    let retainedSnapshot: SkillRecord | undefined, retainedBinding: PreparationBinding | undefined;
    const current = () => {
      checkPreparationSignal(signal);
      if (observedGeneration !== generation || owner !== gate.active || sessionId !== ctx.sessionManager?.getSessionId?.()
        || sessionFile !== ctx.sessionManager?.getSessionFile?.()) throw preparationCancelled();
      const { snapshot, binding, inspection } = resourceSelection(record, reference, ctx);
      const key = recordIdentity(record), prepared = owner?.prepared.get(key);
      if (!inspection && prepared && snapshot && prepared.snapshotId !== snapshot) throw hostError("SOURCE_SESSION_CONFLICT");
      const existing = prepared?.snapshotId === snapshot ? prepared : reusableLoadedSnapshot(hostRecords.get(key) ?? record, ctx, snapshot);
      if (resource) {
        if (retainedBinding) assertFixedOwnerBinding(resource.ownerBinding, retainedBinding);
        if (binding && binding !== retainedBinding) assertFixedOwnerBinding(resource.ownerBinding, binding);
        if (retainedSnapshot) assertFixedResourceSnapshot(resource, reference, retainedSnapshot);
        if (existing && existing !== retainedSnapshot) assertFixedResourceSnapshot(resource, reference, existing);
        if (short) assertShortRefResource(shortRefs.resolve(ctx, short.shortRef), record, resource, resource.file);
      }
      return { existing, binding, inspection };
    };
    const initial = current();
    retainedSnapshot = initial.existing; retainedBinding = initial.binding;
    if (retainedSnapshot && (!retainedSnapshot.preparationBinding || !retainedSnapshot.entryManifest?.manifest_complete))
      throw hostError("SOURCE_CACHE_VERSION_UNSUPPORTED");
    const ref = short?.canonicalRef ?? event.input.path as string;
    let effects: ConsumptionEffects | undefined;
    const ticket = observations.begin(signal);
    try { resource = await options.readFixedResource(record, ref, ctx, signal, { readOnly: piConsumption || event.input.readOnly === true, observeEffects: value => { effects = value; } }); }
    catch (error) { observeFailure(error, ticket, [record], new Set([recordIdentity(record)]), ctx); throw error; }
    current();
    // A main File alias uses entry preparation. Source validation failures never fall back.
    if (!resource) return undefined;
    const file = resource.file, actual = parseNativeReference(file.ref);
    if (resource.selection.scope !== record.sourceScope || resource.selection.owner !== record.id || resource.selection.snapshot_id !== reference.snapshot
      || file.requested_ref !== ref || actual.selector !== reference.selector || actual.snapshot !== reference.snapshot
      || actual.path !== file.path || file.path === resource.entrypoint
      || reference.path !== actual.path) throw hostError("SOURCE_IDENTITY_MISMATCH");
    if (!isAbsolute(file.output)) throw hostError("SOURCE_OUTPUT_CONFLICT");
    if (initial.inspection && (file.bytes !== initial.inspection.file.bytes || file.sha256 !== initial.inspection.file.sha256
      || !isDeepStrictEqual(parseNativeReference(file.ref), parseNativeReference(initial.inspection.file.ref)))) throw hostError("SOURCE_IDENTITY_MISMATCH");
    const display = notionReadDisplay({ ...record, name: resource.ownerBinding.record.name },
      { kind: "file", files: [{ ref: requestedRef, path: file.path }] }, hostRecords.values());
    if (event.toolCallId) pendingResourceReads.set(event.toolCallId, { generation, display, selection: resource.selection, file, assertCurrent: current,
      ...(initial.inspection ? { purpose: "inspect" as const } : {}), effects: consumptionEffects(effects) });
    return { input: { ...event.input, path: file.output }, assertCurrent: current, effects: consumptionEffects(effects), display };
  }

  function blockedRead(error: unknown, phase: ReadAdmission["phase"], stage: ReadAdmissionStage,
    started: number, signal: AbortSignal, effects?: ConsumptionEffects, message?: string): PreparedReadResult {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z_]+$/.test(error.code)
      ? error.code : "SOURCE_ACTIVATION_FAILED";
    const admission: ReadAdmission = { version: 1, phase, stage, code,
      generation_started: started, generation_current: generation, signal_aborted: signal.aborted };
    // The original native call retains its path and source selection. Report
    // only the boundary facts here; a stage is not a new authority proof.
    // Reference ambiguity is already a public JSON choice response. Preserve
    // its top-level candidates; the admission remains available in details.
    const diagnostic = error instanceof SourceError ? sourceFailureDiagnostic(error.code, error.details) : undefined;
    const reason = stage === "reference" && error instanceof SourceReferenceAmbiguity ? failure(error)
      : JSON.stringify({ error: message ?? failure(error), ...(diagnostic ? { diagnostic } : {}), ...(effects ? { effects } : {}), admission });
    return { block: true, reason,
      ...(effects ? { effects } : {}), admission };
  }

  async function resolveRelativeRead(input: { from: string; path: string }, ctx: ExtensionContext, signal: AbortSignal, policy: ConsumptionPolicy): Promise<ResolvedHostReference> {
    if (!options.resolveRelativeReference) throw hostError("SOURCE_SDK_INCOMPATIBLE");
    const observedGeneration = generation, owner = gate.active;
    const sessionId = ctx.sessionManager?.getSessionId?.(), sessionFile = ctx.sessionManager?.getSessionFile?.();
    const current = () => {
      checkPreparationSignal(signal);
      if (observedGeneration !== generation || owner !== gate.active || sessionId !== ctx.sessionManager?.getSessionId?.()
        || sessionFile !== ctx.sessionManager?.getSessionFile?.()) throw preparationCancelled();
    };
    const base = await resolveToolReference(input.from, ctx, signal);
    const from = base.canonicalRef ?? input.from;
    if (!base.reference.snapshot || !base.reference.path || base.short?.kind === "candidate") throw hostError("SOURCE_REFERENCE_INVALID");
    const { record } = await exactReadRecord(base.reference, ctx, signal, base.short, base.record);
    if (record.source !== "notion" || !record.sourceId || !record.sourceScope) throw hostError("SOURCE_IDENTITY_MISMATCH");
    current();
    const ticket = observations.begin(signal);
    let canonicalRef: string;
    try { canonicalRef = await options.resolveRelativeReference(record, from, input.path, ctx, signal, policy); }
    catch (error) { observeFailure(error, ticket, [record], new Set([recordIdentity(record)]), ctx); throw error; }
    current(); assertCanRestore(record);
    let reference = parseNativeReference(canonicalRef);
    const sameLibrary = nativeReferenceLibrary(reference) === nativeReferenceLibrary(base.reference);
    // Reuse a known target from this exact configured source. The containing
    // Skill's version and task role never transfer to the target owner.
    const known = sameLibrary ? contextRecords(ctx).find(target => target.sourceId === record.sourceId && target.sourceScope === record.sourceScope
      && target.id === reference.selector && target.ref?.startsWith("skill://")) : undefined;
    let target = known;
    if (!target) {
      if (!options.resolveSkillReference) throw hostError("SOURCE_REFERENCE_MISSING");
      const located = await options.resolveSkillReference(canonicalRef, ctx, signal, false, sameLibrary ? record.sourceId : undefined);
      current();
      const exact = parseNativeReference(located.ref);
      if (exact.selector !== reference.selector || exact.snapshot !== reference.snapshot
        || reference.path && exact.path !== reference.path
        || !reference.path && exact.path && exact.path !== located.record.entrypoint) throw hostError("SOURCE_IDENTITY_MISMATCH");
      target = located.record;
    }
    if (target.source !== "notion" || !target.sourceId || !target.sourceScope
      || sameLibrary && (target.sourceId !== record.sourceId || target.sourceScope !== record.sourceScope)
      || target.id !== reference.selector) throw hostError("SOURCE_IDENTITY_MISMATCH");
    if (!reference.snapshot) {
      const { snapshot } = assertSourceSelection(target, ctx);
      if (snapshot) {
        canonicalRef = withNativeSnapshot(canonicalRef, snapshot); reference = parseNativeReference(canonicalRef);
      }
    }
    current();
    return { reference, canonicalRef, record: target };
  }

  async function prepareRead(event: ToolCallEvent, ctx: ExtensionContext, signal: AbortSignal, readPhase: "hook" | "execute"): Promise<PreparedReadResult | undefined> {
    if (event.toolName !== "read" || !event.input || typeof event.input.path !== "string") return undefined;
    const requested = event.input.path;
    const started = generation;
    const observedEffects: ConsumptionEffects[] = [];
    const policy: ConsumptionPolicy = { readOnly: piConsumption || event.input.readOnly === true, observeEffects: effects => observedEffects.push(effects) };
    let stage: ReadAdmissionStage = "metadata";
    const blocked = (error: unknown, effects?: ConsumptionEffects, message?: string) => blockedRead(error, readPhase, stage, started, signal,
      effects ?? (observedEffects.length ? combineConsumptionEffects([...observedEffects, errorConsumptionEffects(error)]) : undefined), message);
    if (piConsumption && Object.hasOwn(event.input, "readOnly")) return blocked(hostError("INVALID_ARGUMENT"));
    let relativeInput: ReturnType<typeof relativeReadInput>;
    try { relativeInput = relativeReadInput(event.input); } catch (error) { return blocked(error); }
    const explicit = relativeInput !== undefined || requested.startsWith("skill://") || isSessionShortRefInput(requested) || notionPageId(requested) !== undefined;
    if (event.input.refresh !== undefined && typeof event.input.refresh !== "boolean" || event.input.refresh === true && !explicit) return blocked(hostError("INVALID_ARGUMENT"));
    const refresh = event.input.refresh === true;
    // A plain file read does not acquire a remote Skill dependency. Published
    // broker locations are matched below and activate() retains their gate.
    try { if (!deferredPiDiscovery || explicit) await ready(signal); }
    catch (error) { return blocked(error); }
    stage = "reference";
    let selected: SkillRecord | undefined;
    let suffix = "";
    let reference = "";
    let rootRelative = false;
    let exactReference: ExactNativeReference | undefined;
    let canonicalRef: string | undefined;
    let short: HostShortRefResolution | undefined;
    let confirmedFixedRead = false;
    if (explicit) {
      try {
        let resolved = relativeInput ? await resolveRelativeRead(relativeInput, ctx, signal, policy) : await resolveToolReference(requested, ctx, signal, refresh);
        exactReference = resolved.reference; short = resolved.short;
        canonicalRef = resolved.canonicalRef;
        const located = await exactReadRecord(exactReference, ctx, signal, short, resolved.record);
        selected = located.record; confirmedFixedRead = located.routing === "confirmed-fixed";
        if (refresh) {
          assertRefreshMain(exactReference, selected, ctx, short);
          resolved = await currentRoot(selected, ctx, signal);
          selected = resolved.record!; exactReference = resolved.reference; canonicalRef = resolved.canonicalRef; short = undefined;
        }
        reference = exactReference.path;
      } catch (error) { return blocked(error); }
    } else {
      const raw = isAbsolute(requested) || requested.startsWith("~/") ? requested : join(ctx.cwd ?? process.cwd(), requested);
      let expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
      try {
        const roots = new Set([...readRecords.values()].flatMap(record => record.entryManifest ? [record.entryManifest.root] : []));
        expanded = await canonicalEntryPath(expanded, roots, signal);
      } catch (error) { return blocked(error); }
      for (const [index, record] of readRecords) {
        const spellings = [index, index.startsWith(homedir() + sep) ? `~${index.slice(homedir().length)}` : index];
        const exact = spellings.find((path) => requested === path || requested.startsWith(`${path}:`));
        if (exact) { selected = record; suffix = requested.slice(exact.length); break; }
        const directory = dirname(index);
        if (record.entryManifest && expanded.startsWith(record.entryManifest.root + sep)) {
          selected = record;
          rootRelative = true;
          const remainder = expanded.slice(record.entryManifest.root.length + 1);
          const colon = remainder.indexOf(":");
          reference = colon < 0 ? remainder : remainder.slice(0, colon);
          suffix = colon < 0 ? "" : remainder.slice(colon);
          break;
        }
        if (expanded.startsWith(`${directory}${sep}`)) {
          selected = record;
          const remainder = expanded.slice(directory.length + 1);
          const colon = remainder.indexOf(":");
          reference = colon < 0 ? remainder : remainder.slice(0, colon);
          suffix = colon < 0 ? "" : remainder.slice(colon);
          break;
        }
        if (expandPath(requested, ctx.cwd) === index) { selected = record; break; }
      }
    }
    if (!selected) return undefined;
    let retained: SkillRecord | undefined;
    if (!explicit) {
      retained = selected.kind === "prompt" && !turnPrompts?.signal.aborted ? turnPrompts?.snapshots.get(recordIdentity(selected)) : undefined;
      const queryAt = reference.indexOf("?");
      if (queryAt >= 0) {
        const query = new URLSearchParams(reference.slice(queryAt + 1));
        if ([...query.keys()].some(key => key !== "snapshot") || query.getAll("snapshot").length !== 1) return blocked(hostError("SOURCE_REFERENCE_INVALID"));
        retained ??= gate.active?.prepared.get(recordIdentity(selected)) ?? loaded.get(recordIdentity(selected))?.record;
        if (query.get("snapshot") !== retained?.snapshotId) return blocked(hostError("SOURCE_SESSION_CONFLICT"), undefined, "Requested snapshot is unavailable in the active invocation");
        reference = reference.slice(0, queryAt);
      }
    }
    try {
      if (exactReference && (readPhase === "execute" || exactReference.snapshot && exactReference.path
        && exactReference.path !== selected.entrypoint && resourceSelection(selected, exactReference, ctx).inspection)) {
        stage = "resource";
        const fixed = await prepareFixedResourceRead(canonicalRef ? { ...event, input: { ...event.input, path: canonicalRef } } : event, ctx, signal, selected, exactReference, short, requested);
        if (fixed) {
          if (observedEffects.length) {
            fixed.effects = combineConsumptionEffects([...observedEffects, consumptionEffects(fixed.effects)]);
            const pending = event.toolCallId ? pendingResourceReads.get(event.toolCallId) : undefined;
            if (pending) pending.effects = fixed.effects;
          }
          return fixed;
        }
      }
      stage = "preparation";
      const snapshot = refresh ? await (async () => {
        if (!options.prepareGraph) throw hostError("SOURCE_PREPARATION_INVALID");
        const prepared = await graphPreparation([selected!], ctx, signal, "inspect", undefined, "replace", false, policy);
        observedEffects.push(combineConsumptionEffects(prepared.graphs.map(graph => graph.effects)));
        const current = prepared.records.find(record => recordIdentity(record) === recordIdentity(selected!));
        if (!current) throw hostError("SOURCE_PREPARATION_INVALID");
        return current;
      })() : retained ?? await activate(selected, ctx, signal, true, readPhase,
        exactReference?.snapshot ?? (selected.entryManifest ? selected.snapshotId : undefined), policy);
      if (retained) observedEffects.push(noConsumptionWrites());
      if (short) assertShortRefSnapshot(short, snapshot);
      if (exactReference) reference = nativeResourcePath(exactReference, snapshot);
      else if (snapshot.entryManifest && reference && !rootRelative) {
        const root = snapshot.entryManifest.root;
        reference = relative(root, resolve(root, dirname(snapshot.entrypoint ?? "SKILL.md"), reference)).split(sep).join("/");
      }
      stage = "path_validation";
      await assertEntryFilePath(snapshot, reference || snapshot.entrypoint, signal);
      let path = reference && reference !== (selected.entrypoint ?? "SKILL.md") ? resolve(dirname(snapshot.path), reference) : snapshot.path;
      if (snapshot.entryManifest && reference && reference !== snapshot.entrypoint) {
        stage = "resource";
        if (!options.loadResource) throw hostError("SOURCE_RESOURCE_UNAVAILABLE");
        path = await options.loadResource(snapshot, reference, ctx, signal, policy);
      }
      if (explicit) {
        stage = "path_validation";
        const entrypoint = selected.entrypoint ?? "SKILL.md";
        if (isAbsolute(entrypoint) || /[\\\u0000]/.test(entrypoint) || entrypoint.split("/").some(part => !part || part === "." || part === "..")) throw hostError("SOURCE_REFERENCE_INVALID");
        let root = resolve(snapshot.path);
        for (const _part of entrypoint.split("/")) root = dirname(root);
        if (relative(root, resolve(snapshot.path)) !== entrypoint) throw hostError("SOURCE_OUTPUT_CONFLICT");
        const actualRoot = await realpath(root);
        const requestedPath = resolve(root, reference || entrypoint);
        // Resources are published by hard link. Resolve directory ownership,
        // preserving the selected leaf instead of another name for its inode.
        // lstat below rejects a symlink leaf without following it.
        path = join(await realpath(dirname(requestedPath)), basename(requestedPath));
        const within = relative(actualRoot, path);
        if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within) || !(await lstat(path)).isFile()) throw hostError("SOURCE_REFERENCE_INVALID");
      }
      stage = "admission";
      checkPreparationSignal(signal);
      // A fixed inspection outside the current directory must not republish an
      // old record as a current candidate or alter its task role.
      if (confirmedFixedRead) graphSelectionCommits.delete(snapshot);
      else graphSelectionCommits.get(snapshot)?.();
      const display = piConsumption ? notionReadDisplay(snapshot, reference && reference !== (snapshot.entrypoint ?? "SKILL.md")
        ? { kind: "file", files: [{ ref: requested, path: reference }] } : { kind: "skill", ref: requested }, hostRecords.values()) : undefined;
      if (event.toolCallId && snapshot.entryManifest && reference && reference !== snapshot.entrypoint) {
        const file = snapshot.entryManifest.files.find(file => file.path === reference);
        if (!file) throw hostError("FILE_NOT_FOUND");
        pendingResourceReads.set(event.toolCallId, { generation, display,
          selection: { owner: snapshot.id, scope: snapshot.sourceScope, snapshot_id: snapshot.snapshotId, version_id: snapshot.versionId },
          file: { ...file, file_id: snapshot.fileBindings?.find(binding => binding.path === file.path)?.file_id },
          materialization: publicEntryMaterialization(snapshot), effects: observedEffects.length ? combineConsumptionEffects(observedEffects) : consumptionEffects(undefined) });
      } else if ((!reference || reference === (snapshot.entrypoint ?? "SKILL.md")) && adapter.paths.host === "pi"
        && event.toolCallId && snapshot.kind !== "prompt" && snapshot.sourceId && snapshot.snapshotId) {
        // Bind the authorized snapshot before exposing its resolved path. The
        // native reader may use a canonical parent (/private/tmp on macOS),
        // while the same immutable entry retains its original /tmp spelling.
        // The result hook still requires exact complete source bytes.
        pendingNativeReads.set(event.toolCallId, { record: snapshot, generation, signal, display, effects: observedEffects.length ? combineConsumptionEffects(observedEffects) : consumptionEffects(undefined),
          ...(refresh || confirmedFixedRead ? { purpose: "inspect" as const } : {}) });
      }
      const { from: _from, ...nativeInput } = event.input;
      const updated = { ...nativeInput, path: path + suffix };
      return { input: updated, effects: observedEffects.length ? combineConsumptionEffects(observedEffects) : consumptionEffects(undefined), display };
    } catch (error) {
      const effects = combineConsumptionEffects([...observedEffects, errorConsumptionEffects(error)]);
      return blocked(error, effects);
    }
  }
  async function readResourceBatch(input: Record<string, unknown>, budget: ResourceReadBudget, ctx: ExtensionContext, signal: AbortSignal, toolCallId: string, policy: ConsumptionPolicy) {
    if (adapter.paths.host !== "pi" || !options.readResources) throw hostError("SOURCE_RESOURCE_BATCH_UNAVAILABLE");
    if (Object.keys(input).some(key => key !== "paths" && key !== "budget")
      || !Array.isArray(input.paths) || !input.paths.length
      || input.paths.some(value => typeof value !== "string" || !value)) throw hostError("INVALID_ARGUMENT");
    if (input.paths.length > budget.maxFiles) throw hostError("RESOURCE_FILE_BUDGET");
    const requested = input.paths as string[], observedGeneration = generation;
    const sessionId = ctx.sessionManager?.getSessionId?.(), sessionFile = ctx.sessionManager?.getSessionFile?.();
    const current = () => {
      if (signal.aborted || observedGeneration !== generation || sessionId !== ctx.sessionManager?.getSessionId?.() || sessionFile !== ctx.sessionManager?.getSessionFile?.()) throw hostError("SOURCE_CANCELLED");
    };
    current();
    for (const value of requested) {
      if (!value.startsWith("skill://") && !isSessionShortRefInput(value)) throw hostError("SOURCE_REFERENCE_INVALID");
      const selected = resolveReference(value, ctx);
      if (selected.short && selected.short.kind !== "resource" || !selected.reference.snapshot || !selected.reference.path) throw hostError("SOURCE_REFERENCE_INVALID");
    }
    const resolved: ResolvedHostReference[] = [];
    for (const value of requested) { resolved.push(await resolveToolReference(value, ctx, signal)); current(); }
    const first = resolved[0]!.reference, identities = new Set<string>(), rawRefs = new Set<string>();
    for (const [index, value] of resolved.entries()) {
      const reference = value.reference;
      if (reference.selector !== first.selector || reference.snapshot !== first.snapshot) throw hostError("RESOURCE_SELECTION_CONFLICT");
      const identity = reference.path;
      if (rawRefs.has(requested[index]!) || identities.has(identity)) throw hostError("RESOURCE_SELECTION_CONFLICT");
      rawRefs.add(requested[index]!); identities.add(identity);
    }
    await ready(signal); current();
    const asserted = resolved.find(value => value.short)?.short;
    const named = resolved.find(value => value.record)?.record;
    if (named && resolved.some(value => value.record && recordIdentity(value.record) !== recordIdentity(named))) throw hostError("RESOURCE_SELECTION_CONFLICT");
    const located = await exactReadRecord(first, ctx, signal, asserted, named); current();
    const record = located.record;
    if (record.source !== "notion" || !record.sourceScope || !record.id) throw hostError("SOURCE_IDENTITY_MISMATCH");
    for (const value of resolved) {
      if (located.routing === "confirmed-fixed" && !hasExactFixedReference(record, value.reference)) throw hostError("SOURCE_REFERENCE_MISSING");
      if (value.short) assertShortRefSource(value.short, record);
      if (value.reference.path === record.entrypoint) throw hostError("RESOURCE_MAIN_NOT_ALLOWED");
    }
    const refs = resolved.map(value => value.canonicalRef);
    const selections = resolved.map(value => resourceSelection(record, value.reference, ctx));
    const ticket = observations.begin(signal);
    let batch: ResourceReadBatch;
    try { batch = await options.readResources(record, refs, budget, ctx, signal, policy); }
    catch (error) { observeFailure(error, ticket, [record], new Set([recordIdentity(record)]), ctx); throw error; }
    current();
    if (!isDeepStrictEqual(batch.budget, budget)) throw hostError("SOURCE_RESPONSE_INVALID");
    for (const [index, value] of resolved.entries()) {
      const selected = resourceSelection(record, value.reference, ctx), initial = selections[index]!;
      if (initial.binding) assertFixedOwnerBinding(batch.ownerBinding, initial.binding);
      if (selected.binding) assertFixedOwnerBinding(batch.ownerBinding, selected.binding);
    }
    if (batch.selection.scope !== record.sourceScope || batch.selection.owner !== record.id || batch.selection.snapshot_id !== first.snapshot
      || batch.files.length !== resolved.length) throw hostError("SOURCE_IDENTITY_MISMATCH");
    const files = new Set<string>(), filePaths = new Set<string>();
    const modelRefs = resolved.map((value, index) => {
      const file = batch.files[index]!;
      const actual = parseNativeReference(file.ref);
      if (file.requested_ref !== refs[index] || actual.selector !== first.selector || actual.snapshot !== first.snapshot
        || actual.path !== file.path || file.path === record.entrypoint
        || value.reference.path !== actual.path) throw hostError("SOURCE_IDENTITY_MISMATCH");
      const identity = file.file_id === undefined ? "path:" + file.path : "file:" + file.file_id;
      if (files.has(identity) || filePaths.has(file.path)) throw hostError("RESOURCE_SELECTION_CONFLICT");
      if (located.routing === "confirmed-fixed") assertFixedResourceSnapshot({
        selection: batch.selection, ownerBinding: batch.ownerBinding, entrypoint: record.preparationBinding!.record.entrypoint, file,
      }, value.reference, record);
      const inspected = selections[index]!.inspection?.file;
      if (inspected && (file.bytes !== inspected.bytes || file.sha256 !== inspected.sha256
        || !isDeepStrictEqual(actual, parseNativeReference(inspected.ref)))) throw hostError("SOURCE_IDENTITY_MISMATCH");
      files.add(identity); filePaths.add(file.path);
      if (value.short) {
        // Re-resolve from the current branch after I/O; persisted claims alone
        // never authorize a late result from a different session branch.
        assertShortRefResource(shortRefs.resolve(ctx, value.short.shortRef), record, batch, file);
        return value.short.shortRef;
      }
      return file.ref;
    });
    const result = compileResourceRead({ toolCallId, batch, modelRefs, maxContextBytes: RESOURCE_READ_MAX_CONTEXT_BYTES, effects: batch.effects,
      ...(selections.every(value => value.inspection) ? { purpose: "inspect" as const } : {}) });
    current();
    return withReadDisplay({ ...result, details: { ...(result.details && typeof result.details === "object" ? result.details : {}), effects: batch.effects,
      contextBrokerResourceSource: { source_id: record.sourceId, result: batch.machine } } },
      notionReadDisplay({ ...record, name: batch.ownerBinding.record.name }, { kind: "file",
        files: batch.files.map((file, index) => ({ ref: requested[index]!, path: file.path })) }, hostRecords.values()));
  }
  const readRunsInTool = sourceToolsEnabled ? adapter.registerReadExecutor?.(async (input, ctx, signal, read, toolCallId) => {
    const executionSignal = signal ? AbortSignal.any([signal, lifecycleController.signal]) : lifecycleController.signal;
    if (Object.hasOwn(input, "paths")) {
      const budget = normalizeResourceReadBudget(input.budget);
      const deadline = AbortSignal.timeout(budget.timeBudgetMs);
      const observedEffects: ConsumptionEffects[] = [];
      try { return await readResourceBatch(input, budget, ctx, AbortSignal.any([executionSignal, deadline]), toolCallId,
        { readOnly: true, observeEffects: effects => observedEffects.push(effects) }); }
      catch (error) {
        const cause = executionSignal.aborted ? hostError("SOURCE_CANCELLED") : deadline.aborted ? hostError("RESOURCE_TIME_BUDGET") : error;
        const effects = combineConsumptionEffects([...observedEffects, errorConsumptionEffects(error)]);
        throw consumptionFailure(cause, JSON.stringify({ error: failure(cause), effects }), effects);
      }
    }
    checkPreparationSignal(executionSignal);
    const prepared = await prepareRead({ toolName: "read", toolCallId, input }, ctx, executionSignal, "execute");
    if (prepared && "block" in prepared) throw Object.assign(new Error(prepared.reason), { details: { effects: prepared.effects, admission: prepared.admission } });
    try {
      checkPreparationSignal(executionSignal);
      const result = await read(prepared?.input ?? input, executionSignal);
      checkPreparationSignal(executionSignal);
      prepared?.assertCurrent?.();
      return withReadDisplay(result, prepared?.display);
    } catch (error) {
      pendingResourceReads.delete(toolCallId);
      pendingNativeReads.delete(toolCallId);
      if (prepared?.effects) throw consumptionFailure(error, JSON.stringify({ error: failure(error), effects: prepared.effects }), prepared.effects);
      throw error;
    }
  }, toolCallId => {
    const pending = pendingNativeReads.get(toolCallId) ?? pendingResourceReads.get(toolCallId);
    return pending?.generation === generation && !("signal" in pending && pending.signal.aborted) ? pending.display : undefined;
  }) : undefined;
  host.on("tool_call", async (event, ctx): Promise<ToolCallResult | undefined> => {
    if (event.toolName === "read" && readRunsInTool?.()) return undefined;
    const operationSignal = deferredPiDiscovery && event.toolName === "read" ? ctx.signal : undefined;
    const readSignal = operationSignal ? AbortSignal.any([operationSignal, lifecycleController.signal]) : lifecycleController.signal;
    const started = generation;
    const prepared = await prepareRead(event, ctx, readSignal, "hook");
    if (prepared && "block" in prepared) return prepared;
    if (event.toolName === "read" && readSignal.aborted) return blockedRead(preparationCancelled(), "hook", "admission", started, readSignal, prepared?.effects);
    if (prepared) { Object.assign(event.input, prepared.input); delete event.input.from; }
    return prepared ? adapter.updatedRead(prepared.input) : undefined;
  });
  host.on("tool_result", (event, ctx) => {
    if (event.toolName !== "read" || !event.toolCallId) return undefined;
    const resource = pendingResourceReads.get(event.toolCallId);
    pendingResourceReads.delete(event.toolCallId);
    if (resource && resource.generation === generation && !event.isError && !event.parentToolCallId) {
      try { resource.assertCurrent?.(); } catch { return undefined; }
      const text = typeof event.content === "string" ? event.content
        : event.content?.every(part => part.type === "text") ? event.content.map(part => part.text).join("\n") : undefined;
      const full = typeof text === "string" && Buffer.byteLength(text) === resource.file.bytes &&
        createHash("sha256").update(text).digest("hex") === resource.file.sha256;
      const existing = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details as Record<string, unknown> : {};
      const effects = consumptionEffects(resource.effects);
      const footer = "\n\n<notion-effects>" + JSON.stringify(effects) + "</notion-effects>";
      const content = typeof event.content === "string" ? event.content + footer : [...event.content ?? [], { type: "text" as const, text: footer }];
      return { content, details: { ...existing, effects, contextBrokerResource: {
        version: 2, toolCallId: event.toolCallId, id: resource.selection.owner, scope: resource.selection.scope,
        ...(resource.purpose ? { purpose: resource.purpose } : {}),
        snapshot_id: resource.selection.snapshot_id, version_id: resource.selection.version_id,
        ref: resource.file.ref, path: resource.file.path, bytes: resource.file.bytes, sha256: resource.file.sha256,
        file_id: resource.file.file_id,
        delivery: { start: 0, end: text?.length ?? 0, encoding: "raw" },
        ...(resource.materialization ? { materialization: resource.materialization } : {}), delivered_complete_text: full, loaded: false,
      } } };
    }
    const pending = pendingNativeReads.get(event.toolCallId);
    pendingNativeReads.delete(event.toolCallId);
    if (!pending || pending.generation !== generation || pending.signal.aborted || event.isError || event.parentToolCallId) return undefined;
    const proof = nativeReadReceipt(pending.record, event.toolCallId, event.content, pending.purpose);
    const existing = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details as Record<string, unknown> : {};
    const effects = pending.record.source === "notion" ? consumptionEffects(pending.effects) : undefined;
    const effectsFooter = effects === undefined ? "" : "\n\n<notion-effects>" + JSON.stringify(effects) + "</notion-effects>";
    if (!proof) return effects === undefined ? undefined : {
      content: typeof event.content === "string" ? event.content + effectsFooter : [...event.content ?? [], { type: "text" as const, text: effectsFooter }],
      details: { ...existing, effects },
    };
    // Retain source ownership for later authorization projection even if an
    // outside-catalog inspection disappears from the next metadata directory.
    // This records no availability grant, active binding or loaded instruction.
    if (pending.purpose === "inspect") readRecords.set(resolve(pending.record.path), pending.record);
    const ref = modelReference(pending.record, ctx, true);
    const useRole = pending.record.preparationBinding ? selectedTaskRole(activeSelection(ctx, piRun?.graphs), pending.record.preparationBinding) : undefined;
    const readStatus: NotionReadStatus | undefined = pending.record.source === "notion" ? {
      purpose: "inspect", activation_effect: "unchanged", requires_acquisition: "not_performed",
      use_selection: useRole ? { status: "already_selected_for_use", roles: useRole.roles } : { status: "inspection_only", roles: [] },
    } : undefined;
    if (ref || effects) {
      // The original native result has already proved a complete main read. Keep
      // those exact bytes as the prefix and append only a directory of fixed refs.
      const footer = (ref ? "\n\n<skill-directory>\n" + JSON.stringify({ ref, directory: projectSkillDirectory(modelDirectory(pending.record, [pending.record], ctx)) }) + "\n</skill-directory>" : "")
        + (readStatus ? notionReadStatusFooter(readStatus) : "") + effectsFooter;
      const content = typeof event.content === "string" ? event.content + footer : [...event.content ?? [], { type: "text" as const, text: footer }];
      const delivered = nativeReadReceipt(pending.record, event.toolCallId, content, pending.purpose);
      if (!delivered) throw hostError("SOURCE_PREPARATION_INVALID");
      return { content, details: { ...existing, ...(effects === undefined ? {} : { effects }), contextBrokerRead: { ...delivered,
        ...(readStatus ? { readStatus } : {}), directory: pending.record.preparationDirectory } } };
    }
    return { details: { ...existing, contextBrokerRead: { ...proof, directory: pending.record.preparationDirectory } } };
  });

  const initialMetadata = refresh();
  if (adapter.metadataDiscovery !== "deferred") await initialMetadata;
  return { turnContext, invalidate() { metadataGeneration++; metadataController.abort(); generation++; lifecycleController.abort(); lifecycleController = new AbortController(); gate.cancel(false); turnPrompts = undefined; }, refresh: (ctx, settings) => refresh(ctx, true, settings?.preserveTurn), activate, prepare, prepareMany, withPreparedPrompt: async (prompt, ctx, build) => {
    const receipt = handoff?.prompts.includes(prompt) ? handoff : undefined;
    const selectedGeneration = generation;
    try {
      if (receipt) gate.assertCurrent(receipt.entry, ctx);
      const native = receipt?.consumed && receipt.native?.promptSha256 === createHash("sha256").update(prompt).digest("hex") ? receipt.native.snapshot : undefined;
      const result = await build(receipt?.entry.controller.signal, native, receipt?.entry.event.text, receipt ? [...receipt.entry.prepared.values()] : []);
      if (receipt) gate.assertCurrent(receipt.entry, ctx);
      return result;
    } catch (error) {
      const cancelled = selectedGeneration !== generation || receipt?.entry.controller.signal.aborted;
      if (receipt) receipt.entry.controller.abort();
      if (selectedGeneration === generation && receipt && (!gate.active || gate.active === receipt.entry)) ctx.abort?.();
      // An old consumer must never abort the next submission.
      if (receipt) gate.release(receipt.entry);
      if (cancelled) throw preparationCancelled();
      throw error;
    }
  }, selectedModelReference: (record, ctx) => record.preparationBinding ? modelReference(record, ctx, true) : undefined,
  assertCanRestore,
  withFixedRestoration: async (records, signal, read) => {
    const combined = AbortSignal.any([signal, lifecycleController.signal]), ticket = observations.begin(combined);
    const check = () => {
      checkPreparationSignal(combined);
      if (!observations.current(ticket)) throw preparationCancelled();
      for (const record of records) assertCanRestore(record);
    };
    check();
    try {
      const result = await read(combined);
      check();
      return result;
    } catch (error) {
      observeFailure(error, ticket, records, new Set(records.map(recordIdentity)));
      checkPreparationSignal(combined);
      if (!observations.current(ticket)) throw preparationCancelled();
      throw error;
    }
  },
  selectedModelFiles: modelFiles,
  viewStatus: () => views, isNativeLoaded: (messages, record) => messages.some(message => {
    if (record.source === "notion") return false;
    if (message.role !== "custom" || message.customType !== "skill-prompt" || !message.details || typeof message.details !== "object") return false;
    const path = (message.details as Record<string, unknown>).path;
    const selected = typeof path === "string" ? readRecords.get(resolve(path)) : undefined;
    return selected !== undefined && recordIdentity(selected) === recordIdentity(record);
  }) };
}
