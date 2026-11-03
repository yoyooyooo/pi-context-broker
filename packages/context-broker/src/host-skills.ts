import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { InvocationError, recordIdentity } from "./discovery-records";
import { assertSourceAvailable, formatSourceFailures } from "./sources";
import { SourceError, ReferenceMiss, sourceFailureMessage } from "./notion-source";
import { createActivationFeedback, ACTIVATION_MESSAGE } from "./activation-feedback";
import { checkPreparationSignal, createPreparationGate, preparationCancelled, type ActivePreparation } from "./skill-preparation";
import type { AgentMessage, ConfigFile, ExtensionAPI, ExtensionContext, ImageContent, SkillRecord, DiscoveryResult, SourceFailure, NotionViewState, ToolCallEvent, ToolCallResult } from "./types";
import type { HostCapabilities } from "./host-adapter";
import { invocationText } from "./invocation-text";
import { viewSystemPrompt } from "./view-prompt";
import { notifyUnavailableReferences, renderUnavailableReferences } from "./unavailable-references";
import { deduplicateSourceReads, nativeReadReceipt, sourceDeliveryReceipt } from "./session-source-snapshot";
import { parseNativeReference, nativeResourcePath, type ExactNativeReference } from "./native-reference";
import type { PreparedHostGraph, PreparationPurpose, PreparationBinding } from "./prepare-protocol";
import type { SelectionMode } from "./session-graph";
import { publicEntryMaterialization, type EntryFile } from "./notion-entry";

export type HostSkillOptions = {
  config: ConfigFile;
  getRecords(ctx?: ExtensionContext, signal?: AbortSignal): Promise<DiscoveryResult<SkillRecord>>;
  lookupReference?(ctx: ExtensionContext, signal?: AbortSignal): Promise<DiscoveryResult<SkillRecord>>;
  loadRecord(record: SkillRecord, signal?: AbortSignal, snapshotId?: string): Promise<SkillRecord>;
  loadResource?(record: SkillRecord, path: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<string>;
  prepareGraph?(records: readonly SkillRecord[], ctx: ExtensionContext | undefined, signal: AbortSignal | undefined, purpose: PreparationPurpose, pins?: ReadonlyMap<string, string>, bindings?: readonly PreparationBinding[], mode?: SelectionMode): Promise<PreparedHostGraph[]>;
  persistGraphs?(graphs: readonly PreparedHostGraph[], ctx: ExtensionContext, mode: SelectionMode): void;
  sessionGraph?(ctx: ExtensionContext): unknown;
  projectContext?(messages: AgentMessage[], ctx: ExtensionContext): AgentMessage[];
  needsPreflightPrompt?(text: string): boolean;
  onPreparation?(entry: ActivePreparation): void;
  preflightPrompt?(text: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<void>;
  taskPrompt?(text: string, ctx: ExtensionContext, signal?: AbortSignal, invocation?: ActivePreparation): Promise<string>;
  isLoaded?(record: SkillRecord, ctx: ExtensionContext): boolean;
  sessionSnapshot?(record: SkillRecord, ctx: ExtensionContext): string | undefined;
  onMetadata?(records: SkillRecord[]): void;
};
export type PreparedReference = { status: "ready"; record: SkillRecord } | { status: "miss" };
export type HostSkills = {
  invalidate(): void;
  refresh(ctx?: ExtensionContext): Promise<void>;
  activate(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal): Promise<SkillRecord>;
  prepare(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal): Promise<PreparedReference>;
  prepareMany(records: readonly SkillRecord[], ctx?: ExtensionContext, signal?: AbortSignal): Promise<void>;
  withPreparedPrompt<T>(prompt: string, ctx: ExtensionContext, build: (signal?: AbortSignal, native?: SkillRecord, original?: string, prepared?: readonly SkillRecord[]) => Promise<T>): Promise<T>;
  isNativeLoaded(messages: AgentMessage[], record: SkillRecord): boolean;
  viewStatus(): readonly NotionViewState[];
};

export function hostSkillName(record: SkillRecord): string {
  return (record.token ?? record.name).replace(/[^a-z0-9-]/g, "-");
}
function failure(error: unknown): string {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  if (error instanceof SourceError) return `context-broker source ${error.sourceId} unavailable (${error.code}). ${sourceFailureMessage(error.code)}`;
  if (error instanceof InvocationError) return error.message;
  return `context-broker activation failed (${typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "SOURCE_ACTIVATION_FAILED"})`;
}
function hostError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
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
  const host = api;
  let records: SkillRecord[] = [];
  let defaultRouters: SkillRecord[] = [];
  let views: NotionViewState[] = [];
  let generation = 0;
  let metadataGeneration = 0;
  let metadataController = new AbortController();
  let metadataReadiness: Promise<void> = Promise.resolve();
  let lifecycleController = new AbortController();
  let discoveryError: unknown;
  let sourceFailures: SourceFailure[] = [];
  let metadataFallback = false;
  let filesystemCache: string | undefined;
  const hostRecords = new Map<string, SkillRecord>();
  let catalogPublication: Promise<void> = Promise.resolve();
  const nativeNames = new Map<string, SkillRecord>();
  const readRecords = new Map<string, SkillRecord>();
  const loaded = new Map<string, { record: SkillRecord; owner?: ActivePreparation }>();
  const loading = new Map<string, { operation: Promise<ActivationOutcome<SkillRecord>>; signal?: AbortSignal }>();
  const publishing = new Map<string, Promise<void>>();
  const registeredCommands = new Set<string>();
  const nativeInputs = new Map<string, SkillRecord>();
  const pendingNativeReads = new Map<string, { record: SkillRecord; generation: number }>();
  const pendingResourceReads = new Map<string, { record: SkillRecord; file: EntryFile; generation: number }>();
  const printTurns = new Set<() => void>();
  const gate = createPreparationGate();
  const commandPreparations = new WeakSet<ActivePreparation>();
  const misses = new WeakMap<ActivePreparation, Set<string>>();
  const preparedForUse = new WeakMap<ActivePreparation, Set<string>>();
  const graphSelectionCommits = new WeakMap<SkillRecord, () => void>();
  function beginPreparation(event: { text?: string; images?: ImageContent[] }, ctx: ExtensionContext): ActivePreparation {
    const entry = gate.begin(event, ctx);
    try { options.onPreparation?.(entry); return entry; }
    catch (error) { gate.release(entry); throw error; }
  }
  let turnPrompts: { snapshots: Map<string, SkillRecord>; signal: AbortSignal } | undefined;
  const feedback = await createActivationFeedback(api, gate.repaint);
  let handoff: { entry: ActivePreparation; prompts: string[]; consumed: boolean; native?: { snapshot: SkillRecord; promptSha256: string } } | undefined;
  const nativeCommands = new Map<string, (args: string, ctx: ExtensionContext, images?: ImageContent[], entry?: ActivePreparation) => Promise<void>>();
  host.on("agent_end", () => {
    turnPrompts = undefined;
    pendingNativeReads.clear();
    pendingResourceReads.clear();
    for (const complete of printTurns) complete();
    printTurns.clear();
  });

  async function ready(signal: AbortSignal = lifecycleController.signal): Promise<void> {
    checkPreparationSignal(signal);
    const cancelled = Promise.withResolvers<never>();
    const abort = () => cancelled.reject(preparationCancelled());
    signal.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([metadataReadiness, cancelled.promise]);
      checkPreparationSignal(signal);
    } finally { signal.removeEventListener("abort", abort); }
  }

  host.registerTool?.({
    name: "skill_search", label: "Skill search",
    description: "Search the authorized Skill metadata directory, including items outside the default View. Returns exact read references only; it does not load instructions or activate workflows.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "A short name or description keyword; empty lists the directory." },
      source: { type: "string", description: "Optional configured source ID to disambiguate directories." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum metadata entries, default 20." },
    }, required: ["query"], additionalProperties: false },
    strict: true, readsSkillUris: false, loadMode: "essential",
    approval: () => "read", approvalCacheTargets: () => undefined,
    sourcePath: import.meta.url, defaultInactive: false,
    async execute(_id, input, signal, _onUpdate, ctx) {
      const readSignal = signal ? AbortSignal.any([signal, lifecycleController.signal]) : lifecycleController.signal;
      await ready(readSignal);
      if (discoveryError) throw discoveryError;
      if (typeof input.query !== "string" || input.query.length > 512
        || input.source !== undefined && typeof input.source !== "string"
        || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)
        || Object.keys(input).some(key => !["query", "source", "limit"].includes(key))) throw hostError("INVALID_ARGUMENT");
      const query = input.query.trim().toLocaleLowerCase();
      const matches = [...hostRecords.values()].filter(record => record.ref && record.source === "notion"
        && (input.source === undefined || record.sourceId === input.source)
        && (!query || [record.name, record.alias, record.description].some(value => value?.toLocaleLowerCase().includes(query))));
      const result = {
        ok: true, state: "known", count: matches.length, has_more: matches.length > Number(input.limit ?? 20),
        records: matches.slice(0, Number(input.limit ?? 20)).map(record => ({
          id: record.id, ref: record.ref, kind: record.kind, name: record.name, description: record.description,
          source: record.sourceId, scope: record.sourceScope, in_default_view: record.defaultDiscovery === true,
          availability: record.enabled === false ? "disabled" : "available",
        })),
        failures: sourceFailures.map(({ sourceId, code }) => ({ source: sourceId, code })),
      };
      checkPreparationSignal(readSignal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
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
      let snapshotRoot = snapshot.entryManifest?.root ?? dirname(resolve(snapshot.path));
      const notion = options.config.sources?.some((source) => source.id === record.sourceId && source.type === "notion");
      while (notion && !snapshot.entryManifest) {
        try { await lstat(join(snapshotRoot, ".broker-snapshot.json")); break; }
        catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
          const parent = dirname(snapshotRoot);
          if (parent === snapshotRoot) throw hostError("SOURCE_SNAPSHOT_RECEIPT_MISSING");
          snapshotRoot = parent;
        }
      }
      // Full exports retain their complete tree. Entry-ready indexes contain only
      // the main; resource reads resolve through its verified immutable manifest.
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

  async function graphPreparation(selected: readonly SkillRecord[], ctx: ExtensionContext | undefined, signal: AbortSignal, purpose: PreparationPurpose, pins?: ReadonlyMap<string, string>, mode: SelectionMode = "extend", commitNow = true): Promise<{ records: SkillRecord[]; graphs: PreparedHostGraph[]; commit(): void }> {
    const owner = gate.active, observedGeneration = generation;
    const observedSession = ctx?.sessionManager?.getSessionId?.();
    const bindings = mode === "replace" ? [] : [...owner?.prepared.values() ?? []].flatMap(record => record.preparationBinding ? [record.preparationBinding] : []);
    const graphs = await options.prepareGraph!(selected, ctx, signal, purpose, pins, bindings, mode);
    checkPreparationSignal(signal);
    if (generation !== observedGeneration || observedSession !== ctx?.sessionManager?.getSessionId?.()) throw preparationCancelled();
    if (owner) gate.assertCurrent(owner, ctx ?? owner.ctx);
    const values = graphs.flatMap(graph => graph.records);
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
    for (const record of values) {
      checkPreparationSignal(signal);
      const key = recordIdentity(record), metadata = hostRecords.get(key) ?? record;
      if (record.kind === "skill") await publish(metadata, record, signal);
      checkPreparationSignal(signal);
      if (generation !== observedGeneration) throw preparationCancelled();
    }
    let committed = false;
    function commit() {
      if (committed) return;
      checkPreparationSignal(signal);
      if (generation !== observedGeneration || observedSession !== ctx?.sessionManager?.getSessionId?.()) throw preparationCancelled();
      if (owner) gate.assertCurrent(owner, ctx ?? owner.ctx);
      // Exact root/File identity and response budgets are checked by the caller
      // before this transition. A failed refresh cannot replace the prior lock.
      if (ctx) options.persistGraphs?.(graphs, ctx, mode);
      if (mode === "replace" && owner) { owner.prepared.clear(); preparedForUse.delete(owner); }
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
    else for (const record of values) graphSelectionCommits.set(record, commit);
    return { records: values, graphs, commit };
  }

  async function prepareMany(selected: readonly SkillRecord[], ctx?: ExtensionContext, signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, lifecycleController.signal]) : lifecycleController.signal;
    await ready(combined);
    if (discoveryError) throw discoveryError;
    const graphRoots = [...new Map(selected.filter(record => record.source === "notion" && record.kind !== "prompt")
      .map(record => [recordIdentity(record), record])).values()]
      .filter(record => !gate.active || !preparedForUse.get(gate.active)?.has(recordIdentity(record)) && !misses.get(gate.active)?.has(recordIdentity(record)));
    if (options.prepareGraph && graphRoots.length) {
      const finish = feedback.begin(graphRoots[0]!, ctx, "use", options.config.sources?.find(source => source.id === graphRoots[0]!.sourceId && source.type === "notion"));
      try {
        const values = await graphPreparation(graphRoots, ctx, combined, "use");
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
        for (const record of graphRoots) if (recordIdentity(record) !== recordIdentity(missing)) await prepare(record, ctx, combined);
        finish?.({ skipped: true });
      }
    }
    for (const record of selected) if (!options.prepareGraph || record.source !== "notion" || record.kind === "prompt") await prepare(record, ctx, combined);
  }

  async function activate(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal, waitForTool = false, readPhase: "hook" | "execute" = "hook", requestedSnapshot?: string): Promise<SkillRecord> {
    signal = signal ? AbortSignal.any([signal, lifecycleController.signal]) : lifecycleController.signal;
    checkPreparationSignal(signal);
    await ready(signal);
    if (discoveryError) throw discoveryError;
    if (record.sourceId) {
      const unavailable = sourceFailures.find(failure => failure.sourceId === record.sourceId && failure.blocking !== false);
      if (unavailable) throw new SourceError(unavailable.code, unavailable.sourceId);
    }
    const key = recordIdentity(record);
    if (gate.active) gate.assertCurrent(gate.active, ctx ?? gate.active.ctx);
    const activeSnapshot = ctx ? options.sessionSnapshot?.(record, ctx) : undefined;
    if (requestedSnapshot && activeSnapshot && requestedSnapshot !== activeSnapshot) throw hostError("SOURCE_SESSION_CONFLICT");
    const sessionSnapshot = requestedSnapshot ?? activeSnapshot;
    const prepared = gate.active?.prepared.get(key);
    const graphUse = !waitForTool && options.prepareGraph && record.source === "notion" && record.kind !== "prompt";
    if (prepared && (!graphUse || gate.active && preparedForUse.get(gate.active)?.has(key))) {
      if (sessionSnapshot && prepared.snapshotId !== sessionSnapshot) throw hostError("SOURCE_SESSION_CONFLICT");
      checkPreparationSignal(signal);
      return prepared;
    }
    record = hostRecords.get(key) ?? record;
    const selectedGeneration = generation;
    const preparationOwner = gate.active;
    const pinned = loaded.get(key);
    const existing = record.kind !== "prompt" && pinned && (!sessionSnapshot || pinned.record.snapshotId === sessionSnapshot) && ((ctx && options.isLoaded?.(pinned.record, ctx)) || (gate.active && pinned.owner === gate.active)) ? pinned.record : undefined;
    if (existing && !graphUse) { await publish(record, existing, signal); checkPreparationSignal(signal); return existing; }
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
        if (!options.prepareGraph || record.source !== "notion" || record.kind === "prompt") return options.loadRecord(record, child, sessionSnapshot);
        const values = await graphPreparation([record], ctx, child, waitForTool ? "inspect" : "use", sessionSnapshot && record.id ? new Map([[record.id, sessionSnapshot]]) : undefined, "extend", !waitForTool);
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
      finish?.({ value: outcome.value });
      return outcome.value;
    } catch (error) {
      finish?.(error instanceof ReferenceMiss ? { skipped: true } : { error: signal?.aborted ? "Cancelled." : failure(error) });
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelled);
      if (loading.get(key) === owner) loading.delete(key);
    }
  }

  async function prepare(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal): Promise<PreparedReference> {
    const entry = gate.active;
    const key = recordIdentity(record);
    if (entry && misses.get(entry)?.has(key)) return { status: "miss" };
    try { return { status: "ready", record: await activate(record, ctx, signal) }; }
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
  async function preflight(text: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
    checkPreparationSignal(signal);
    await ready(signal);
    text = invocationText(text);
    if (discoveryError && /(?:^|\s)(?:\$[^\s]+|\/skill:[^\s]+)/.test(text)) throw discoveryError;
    const record = nativeRecord(text);
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

  async function refreshMetadata(ctx?: ExtensionContext, announce = true): Promise<void> {
    const selectedGeneration = ++metadataGeneration;
    metadataController.abort();
    metadataController = new AbortController();
    const metadataSignal = metadataController.signal;
    generation++;
    lifecycleController.abort();
    lifecycleController = new AbortController();
    gate.cancel();
    turnPrompts = undefined;
    try {
      const result = await options.getRecords(ctx, metadataSignal);
      if (metadataGeneration !== selectedGeneration) return;
      sourceFailures = result.failures;
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
        if (metadataGeneration !== selectedGeneration) return;
        views = result.views ?? [];
        defaultRouters = next.filter(record => record.kind === "router" && record.defaultDiscovery === true);
        records = next.filter(record => (record.kind === undefined || record.kind === "skill") && (!options.config.sources?.some(source => source.id === record.sourceId && source.type === "notion") || record.defaultDiscovery === true));
        nativeNames.clear();
        hostRecords.clear();
        for (const [name, record] of names) nativeNames.set(name, record);
        for (const record of next) {
          hostRecords.set(recordIdentity(record), record);
          readRecords.set(resolve(record.metadataIndexPath ?? record.path), record);
          readRecords.set(resolve(record.path), record);
        }
        nativeInputs.clear();
        loading.clear();
        discoveryError = undefined;
        await updateDirectories(metadataSignal);
        if (metadataGeneration !== selectedGeneration) return;
        for (const record of records) for (const path of adapter.catalogPaths?.(record) ?? []) readRecords.set(resolve(path), record);
        registerNativeCommands();
        options.onMetadata?.(next);
        if (ctx) {
          for (const message of formatSourceFailures(sourceFailures)) ctx.ui?.notify?.(message, "warning");
          if (announce) ctx.ui?.notify?.("context-broker: source metadata refreshed", "info");
        }
        // Reconcile the prompt at before_agent_start; View switches do not reload the session.
      } finally { release(); }
    } catch (error) { if (metadataGeneration === selectedGeneration) { discoveryError = error; if (ctx) notify(ctx, error); } }
  }

  function refresh(ctx?: ExtensionContext, announce = true): Promise<void> {
    metadataReadiness = refreshMetadata(ctx, announce);
    return metadataReadiness;
  }

  if (adapter.submission.mode === "command" && host.registerCommand) host.registerCommand("context-broker-submit", {
    description: "Activate selected source Skills and resume the submitted prompt",
    async handler(id, ctx) {
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
    // Pi's initial factory discovery stays synchronous; every actual submission
    // still awaits metadataReadiness before publishing its selected directory.
    void ready.catch(() => undefined);
  });
  host.on("session_shutdown", () => {
    generation++;
    metadataGeneration++;
    metadataController.abort();
    lifecycleController.abort();
    gate.cancel(false);
    const entry = gate.active;
    if (entry) gate.release(entry);
    handoff = undefined;
    turnPrompts = undefined;
    nativeInputs.clear();
  });
  host.on("agent_start", (_event, ctx) => {
    const entry = gate.active;
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
  api.on("context", (event, ctx) => {
    try { return { messages: deduplicateSourceReads(options.projectContext?.(event.messages.filter(message => message.customType !== ACTIVATION_MESSAGE), ctx) ?? event.messages.filter(message => message.customType !== ACTIVATION_MESSAGE)) }; }
    catch (error) { ctx.abort?.(); throw error; }
  });
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
    const needsPreparation = Boolean(/^\s*\/skill:[^\s]+/.test(text) || options.needsPreflightPrompt?.(text));
    // Synchronous ownership closes the second-Enter gap before this hook's first await.
    const entry = needsPreparation ? beginPreparation(event, ctx) : undefined;
    const submissionSignal = entry?.controller.signal ?? lifecycleController.signal;
    const submissionGeneration = generation;
    try {
      // Cold preparation belongs to the registered command, outside the input hook budget.
      if (entry && adapter.submission.mode === "command") return adapter.transformInput(`/context-broker-submit ${entry.id}`);
      await preflight(text, ctx, submissionSignal);
      checkPreparationSignal(submissionSignal);
      if (submissionGeneration !== generation) throw preparationCancelled();
      if (entry) gate.assertCurrent(entry, ctx);
      const record = adapter.submission.mode === "transform" && text.startsWith("/skill:") ? nativeRecord(text) : undefined;
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
    // before_agent_start has no input provenance; only a matching current receipt
    // may activate content. Delegated/bootstrap text is passed through unchanged.
    const beforeSignal = lifecycleController.signal, beforeGeneration = generation;
    try { await ready(beforeSignal); }
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
    const systemPrompt = viewSystemPrompt(event.systemPrompt, records, defaultRouters, new Set(readRecords.keys()), views, ctx.cwd);
    return { ...(message ? { message } : {}), systemPrompt: adapter.systemPrompt?.(systemPrompt) ?? systemPrompt };
  });
  async function exactRecord(reference: ExactNativeReference, ctx: ExtensionContext, signal: AbortSignal): Promise<SkillRecord> {
    const selector = reference.selector;
    assertSourceAvailable(selector, sourceFailures, true);
    let candidates = [...hostRecords.values()].filter(record => record.ref?.startsWith("skill://") && parseNativeReference(record.ref).selector === selector);
    if (!candidates.length && options.lookupReference) {
      const observedGeneration = generation;
      const fresh = await options.lookupReference(ctx, signal);
      checkPreparationSignal(signal);
      if (observedGeneration !== generation) throw preparationCancelled();
      candidates = fresh.records.filter(record => record.source === "notion" && record.ref
        && parseNativeReference(record.ref).selector === selector);
      if (!candidates.length && fresh.failures.some(item => item.blocking !== false)) {
        const failed = fresh.failures.find(item => item.blocking !== false)!;
        throw new SourceError(failed.code, failed.sourceId);
      }
    }
    const active = gate.active?.prepared ?? (turnPrompts?.signal.aborted ? undefined : turnPrompts?.snapshots);
    const scopes = [...(active?.values() ?? [])].filter(record => record.sourceScope !== undefined);
    if (scopes.length) candidates = candidates.filter(record => scopes.some(scope => scope.sourceId === record.sourceId && scope.sourceScope === record.sourceScope));
    if (candidates.length > 1) throw new InvocationError(selector, "ambiguous", candidates);
    const selected = candidates[0];
    if (!selected) throw hostError("SOURCE_REFERENCE_MISSING");
    hostRecords.set(recordIdentity(selected), selected);
    return selected;
  }
  if (options.prepareGraph) host.registerTool?.({
    name: "skill_prepare", label: "Prepare Skills",
    description: "Prepare exact Skill roots. Use purpose use to load complete root and Required instructions before executing a workflow; inspect reads only roots and does not activate their dependencies. Members and ordinary references remain directories.",
    parameters: { type: "object", properties: {
      roots: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" }, description: "Exact skill:// main-entry references from metadata or a previous result." },
      purpose: { type: "string", enum: ["use", "inspect"], description: "Explicit operation intent; inspection does not authorize workflow execution." },
      refresh: { type: "boolean", description: "Explicitly begin a new selection for these scopes after successful online preparation. Requires unfixed root refs; existing versions remain in history." },
    }, required: ["roots", "purpose"], additionalProperties: false },
    strict: true, readsSkillUris: true, loadMode: "essential", approval: () => "read", approvalCacheTargets: () => undefined,
    sourcePath: import.meta.url, defaultInactive: false,
    async execute(id, input, signal, _onUpdate, ctx) {
      const combined = signal ? AbortSignal.any([signal, lifecycleController.signal]) : lifecycleController.signal;
      await ready(combined);
      if (discoveryError) throw discoveryError;
      if (!["use", "inspect"].includes(String(input.purpose)) || !Array.isArray(input.roots) || !input.roots.length || input.roots.length > 64
        || input.roots.some(value => typeof value !== "string") || input.refresh !== undefined && typeof input.refresh !== "boolean"
        || Object.keys(input).some(key => !["roots", "purpose", "refresh"].includes(key))) throw hostError("INVALID_ARGUMENT");
      const roots: SkillRecord[] = [], pins = new Map<string, string>();
      for (const raw of input.roots) {
        const reference = parseNativeReference(String(raw));
        if (input.refresh === true && reference.snapshot) throw hostError("PREPARE_VERSION_CONFLICT");
        const record = await exactRecord(reference, ctx, combined);
        if (reference.path && reference.path !== record.entrypoint || record.kind === "prompt") throw hostError("PREPARE_ROOT_NOT_MAIN");
        if (reference.snapshot && record.id) {
          if (pins.has(record.id) && pins.get(record.id) !== reference.snapshot) throw hostError("SOURCE_SESSION_CONFLICT");
          pins.set(record.id, reference.snapshot);
        }
        roots.push(record);
      }
      const purpose = input.purpose === "use" ? "use" : "inspect";
      const prepared = await graphPreparation(roots, ctx, combined, purpose, pins, input.refresh === true ? "replace" : "extend", false);
      for (let index = 0; index < input.roots.length; index++) {
        const reference = parseNativeReference(String(input.roots[index]));
        const record = prepared.records.find(record => recordIdentity(record) === recordIdentity(roots[index]!));
        if (!record || nativeResourcePath(reference, record) !== record.entrypoint) throw hostError("PREPARE_ROOT_NOT_MAIN");
      }
      const unique = [...new Map(prepared.records.map(record => [JSON.stringify([record.sourceScope, record.id]), record])).values()];
      const result = {
        ok: true, status: "ready", purpose,
        graphs: prepared.graphs.map(graph => ({ scope: graph.scope, roots: graph.roots, graph_lock: graph.lock, budget: graph.budget, usage: graph.usage })),
        records: unique.map(record => ({
          id: record.id, scope: record.sourceScope, ref: record.preparationBinding!.ref, snapshot_id: record.snapshotId,
          version_id: record.versionId, body_sha256: record.preparationBinding!.body_sha256, bytes: Buffer.byteLength(record.body!),
          content: record.body!, path: record.path, directory: record.preparationDirectory,
          ...(record.entryManifest ? { materialization: publicEntryMaterialization(record) } : {}),
        })),
      };
      const content = JSON.stringify(result);
      if (Buffer.byteLength(content) > Math.min(...prepared.graphs.map(graph => graph.budget.maxContextBytes))) throw hostError("PREPARE_CONTEXT_BUDGET");
      checkPreparationSignal(combined);
      let recordOffset = content.indexOf('"records":[');
      const receipts = unique.map((record, index) => {
        const serialized = JSON.stringify(result.records[index]);
        recordOffset = content.indexOf(serialized, recordOffset);
        const start = recordOffset + serialized.indexOf('"content":' + JSON.stringify(record.body)) + '"content":"'.length;
        recordOffset += serialized.length;
        return sourceDeliveryReceipt(record, content, "json", start);
      });
      if (receipts.some(receipt => receipt === undefined)) throw hostError("SOURCE_PREPARATION_INVALID");
      checkPreparationSignal(combined);
      prepared.commit();
      return {
        content: [{ type: "text", text: content }],
        details: { contextBrokerPreparation: { version: 1, toolCallId: id, purpose,
          records: receipts, graphs: result.graphs } },
      };
    },
  });
  if (options.sessionGraph) host.registerTool?.({
    name: "skill_graph", label: "Selected Skill graph",
    description: "Export this branch's selected immutable Skill graph and current body-delivery state. Includes identity, version and relation proofs; no credentials, machine paths or conversation text.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true, readsSkillUris: false, loadMode: "essential", approval: () => "read", approvalCacheTargets: () => undefined,
    sourcePath: import.meta.url, defaultInactive: false,
    async execute(_id, input, signal, _update, ctx) {
      checkPreparationSignal(signal);
      if (Object.keys(input).length) throw hostError("INVALID_ARGUMENT");
      const result = options.sessionGraph!(ctx);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  async function prepareRead(event: ToolCallEvent, ctx: ExtensionContext, signal: AbortSignal, readPhase: "hook" | "execute"): Promise<ToolCallResult | undefined> {
    if (event.toolName !== "read" || !event.input || typeof event.input.path !== "string") return undefined;
    const requested = event.input.path;
    try { await ready(signal); }
    catch (error) { return { block: true, reason: failure(error) }; }
    let selected: SkillRecord | undefined;
    let suffix = "";
    let reference = "";
    let rootRelative = false;
    let exactReference: ExactNativeReference | undefined;
    const explicit = requested.startsWith("skill://");
    if (explicit && discoveryError) return { block: true, reason: failure(discoveryError) };
    if (explicit) {
      try {
        exactReference = parseNativeReference(requested);
        selected = await exactRecord(exactReference, ctx, signal);
        reference = exactReference.path;
      } catch (error) { return { block: true, reason: failure(error) }; }
    } else {
      const raw = isAbsolute(requested) || requested.startsWith("~/") ? requested : join(ctx.cwd ?? process.cwd(), requested);
      let expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
      try {
        const roots = new Set([...readRecords.values()].flatMap(record => record.entryManifest ? [record.entryManifest.root] : []));
        expanded = await canonicalEntryPath(expanded, roots, signal);
      } catch (error) { return { block: true, reason: failure(error) }; }
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
        if ([...query.keys()].some(key => key !== "snapshot") || query.getAll("snapshot").length !== 1) return { block: true, reason: failure(hostError("SOURCE_REFERENCE_INVALID")) };
        retained ??= gate.active?.prepared.get(recordIdentity(selected)) ?? loaded.get(recordIdentity(selected))?.record;
        if (query.get("snapshot") !== retained?.snapshotId) return { block: true, reason: "Requested snapshot is unavailable in the active invocation" };
        reference = reference.slice(0, queryAt);
      }
    }
    try {
      const snapshot = retained ?? await activate(selected, ctx, signal, true, readPhase,
        exactReference?.snapshot ?? (selected.entryManifest ? selected.snapshotId : undefined));
      if (exactReference) reference = nativeResourcePath(exactReference, snapshot);
      else if (snapshot.entryManifest && reference && !rootRelative) {
        const root = snapshot.entryManifest.root;
        reference = relative(root, resolve(root, dirname(snapshot.entrypoint ?? "SKILL.md"), reference)).split(sep).join("/");
      }
      await assertEntryFilePath(snapshot, reference || snapshot.entrypoint, signal);
      let path = reference && reference !== (selected.entrypoint ?? "SKILL.md") ? resolve(dirname(snapshot.path), reference) : snapshot.path;
      if (snapshot.entryManifest && reference && reference !== snapshot.entrypoint) {
        if (!options.loadResource) throw hostError("SOURCE_RESOURCE_UNAVAILABLE");
        path = await options.loadResource(snapshot, reference, ctx, signal);
      }
      if (explicit) {
        const entrypoint = selected.entrypoint ?? "SKILL.md";
        if (isAbsolute(entrypoint) || /[\\\u0000]/.test(entrypoint) || entrypoint.split("/").some(part => !part || part === "." || part === "..")) throw hostError("SOURCE_REFERENCE_INVALID");
        let root = resolve(snapshot.path);
        for (const _part of entrypoint.split("/")) root = dirname(root);
        if (relative(root, resolve(snapshot.path)) !== entrypoint) throw hostError("SOURCE_OUTPUT_CONFLICT");
        const actualRoot = await realpath(root);
        path = await realpath(resolve(root, reference || entrypoint));
        const within = relative(actualRoot, path);
        if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within) || !(await lstat(path)).isFile()) throw hostError("SOURCE_REFERENCE_INVALID");
      }
      checkPreparationSignal(signal);
      graphSelectionCommits.get(snapshot)?.();
      if (event.toolCallId && snapshot.entryManifest && reference && reference !== snapshot.entrypoint) {
        const file = snapshot.entryManifest.files.find(file => file.path === reference);
        if (!file) throw hostError("FILE_NOT_FOUND");
        pendingResourceReads.set(event.toolCallId, { record: snapshot, file, generation });
      }
      const updated = { ...event.input, path: path + suffix };
      return { input: updated };
    } catch (error) { return { block: true, reason: failure(error) }; }
  }
  const readRunsInTool = adapter.registerReadExecutor?.(async (input, ctx, signal, read) => {
    const executionSignal = signal ? AbortSignal.any([signal, lifecycleController.signal]) : lifecycleController.signal;
    checkPreparationSignal(executionSignal);
    const prepared = await prepareRead({ toolName: "read", input }, ctx, executionSignal, "execute");
    if (prepared && "block" in prepared) throw new Error(prepared.reason);
    checkPreparationSignal(executionSignal);
    const result = await read(prepared?.input ?? input, executionSignal);
    checkPreparationSignal(executionSignal);
    return result;
  });
  host.on("tool_call", async (event, ctx) => {
    if (event.toolName === "read" && readRunsInTool?.()) return undefined;
    const prepared = await prepareRead(event, ctx, lifecycleController.signal, "hook");
    if (prepared && "block" in prepared) return prepared;
    if (prepared) Object.assign(event.input, prepared.input);
    // Only this broker's successful whole-entry read can create a persisted
    // loaded receipt. Resource reads, user text and nested tool activity cannot.
    if (adapter.paths.host === "pi" && event.toolName === "read" && event.toolCallId && typeof event.input.path === "string") {
      const path = expandPath(event.input.path, ctx.cwd);
      const record = [...loaded.values()].map(value => value.record).find(value => resolve(value.path) === path);
      if (record?.kind !== "prompt" && record?.sourceId && record.snapshotId) pendingNativeReads.set(event.toolCallId, { record, generation });
    }
    return prepared ? adapter.updatedRead(prepared.input) : undefined;
  });
  host.on("tool_result", (event) => {
    if (event.toolName !== "read" || !event.toolCallId) return undefined;
    const resource = pendingResourceReads.get(event.toolCallId);
    pendingResourceReads.delete(event.toolCallId);
    if (resource && resource.generation === generation && !event.isError && !event.parentToolCallId) {
      const text = typeof event.content === "string" ? event.content : event.content?.filter(part => part.type === "text").map(part => part.text).join("\n");
      const full = typeof text === "string" && Buffer.byteLength(text) === resource.file.bytes &&
        createHash("sha256").update(text).digest("hex") === resource.file.sha256;
      const existing = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details as Record<string, unknown> : {};
      return { details: { ...existing, contextBrokerResource: {
        version: 1, toolCallId: event.toolCallId, id: resource.record.id, scope: resource.record.sourceScope,
        snapshot_id: resource.record.snapshotId, version_id: resource.record.versionId,
        ref: resource.file.ref, path: resource.file.path, bytes: resource.file.bytes, sha256: resource.file.sha256,
        file_id: resource.record.fileBindings?.find(binding => binding.path === resource.file.path)?.file_id,
        materialization: publicEntryMaterialization(resource.record), delivered_complete_text: full, loaded: false,
      } } };
    }
    const pending = pendingNativeReads.get(event.toolCallId);
    pendingNativeReads.delete(event.toolCallId);
    if (!pending || pending.generation !== generation || event.isError || event.parentToolCallId) return undefined;
    const proof = nativeReadReceipt(pending.record, event.toolCallId, event.content);
    if (!proof) return undefined;
    const existing = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details as Record<string, unknown> : {};
    return { details: { ...existing, contextBrokerRead: proof } };
  });

  const initialMetadata = refresh();
  if (adapter.metadataDiscovery !== "deferred") await initialMetadata;
  return { invalidate() { metadataGeneration++; metadataController.abort(); generation++; lifecycleController.abort(); lifecycleController = new AbortController(); gate.cancel(false); turnPrompts = undefined; }, refresh, activate, prepare, prepareMany, withPreparedPrompt: async (prompt, ctx, build) => {
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
  }, viewStatus: () => views, isNativeLoaded: (messages, record) => messages.some(message => {
    if (record.source === "notion") return false;
    if (message.role !== "custom" || message.customType !== "skill-prompt" || !message.details || typeof message.details !== "object") return false;
    const path = (message.details as Record<string, unknown>).path;
    const selected = typeof path === "string" ? readRecords.get(resolve(path)) : undefined;
    return selected !== undefined && recordIdentity(selected) === recordIdentity(record);
  }) };
}
