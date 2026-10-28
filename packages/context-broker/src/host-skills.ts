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
import type { AgentMessage, ConfigFile, ExtensionAPI, ExtensionContext, ImageContent, SkillRecord, DiscoveryResult, SourceFailure, NotionViewState } from "./types";
import type { HostCapabilities } from "./host-adapter";
import { invocationText } from "./invocation-text";
import { viewSystemPrompt } from "./view-prompt";
import { notifyUnavailableReferences, renderUnavailableReferences } from "./unavailable-references";

export type HostSkillOptions = {
  config: ConfigFile;
  getRecords(ctx?: ExtensionContext, signal?: AbortSignal): Promise<DiscoveryResult<SkillRecord>>;
  loadRecord(record: SkillRecord, signal?: AbortSignal): Promise<SkillRecord>;
  needsPreflightPrompt?(text: string): boolean;
  onPreparation?(entry: ActivePreparation): void;
  preflightPrompt?(text: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<void>;
  taskPrompt?(text: string, ctx: ExtensionContext, signal?: AbortSignal, invocation?: ActivePreparation): Promise<string>;
  isLoaded?(record: SkillRecord, ctx: ExtensionContext): boolean;
  onMetadata?(records: SkillRecord[]): void;
};
export type PreparedReference = { status: "ready"; record: SkillRecord } | { status: "miss" };
export type HostSkills = {
  invalidate(): void;
  refresh(ctx?: ExtensionContext): Promise<void>;
  activate(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal): Promise<SkillRecord>;
  prepare(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal): Promise<PreparedReference>;
  withPreparedPrompt<T>(prompt: string, ctx: ExtensionContext, build: (signal?: AbortSignal, native?: SkillRecord, original?: string) => Promise<T>): Promise<T>;
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
  const printTurns = new Set<() => void>();
  const gate = createPreparationGate();
  const misses = new WeakMap<ActivePreparation, Set<string>>();
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
      let snapshotRoot = dirname(resolve(snapshot.path));
      const notion = options.config.sources?.some((source) => source.id === record.sourceId && source.type === "notion");
      while (notion) {
        try { await lstat(join(snapshotRoot, ".broker-snapshot.json")); break; }
        catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
          const parent = dirname(snapshotRoot);
          if (parent === snapshotRoot) throw hostError("SOURCE_SNAPSHOT_RECEIPT_MISSING");
          snapshotRoot = parent;
        }
      }
      // Copy the complete export, including siblings referenced via ../ from a nested entry.
      const indexRoot = dirname(dirname(directory));
      const publishedRoot = join(indexRoot, ".host-snapshots", randomUUID());
      await mkdir(dirname(publishedRoot), { recursive: true, mode: 0o700 });
      await cp(snapshotRoot, publishedRoot, { recursive: true, errorOnExist: true, force: false });
      const publishedEntry = join(publishedRoot, relative(snapshotRoot, resolve(snapshot.path)));
      await writeFile(publishedEntry, aliasContent, { mode: 0o600 });
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

  async function activate(record: SkillRecord, ctx?: ExtensionContext, signal?: AbortSignal, waitForTool = false): Promise<SkillRecord> {
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
    const prepared = gate.active?.prepared.get(key);
    if (prepared) { checkPreparationSignal(signal); return prepared; }
    record = hostRecords.get(key) ?? record;
    const selectedGeneration = generation;
    const preparationOwner = gate.active;
    const pinned = loaded.get(key);
    const existing = record.kind !== "prompt" && pinned && ((ctx && options.isLoaded?.(pinned.record, ctx)) || (gate.active && pinned.owner === gate.active)) ? pinned.record : undefined;
    if (existing) { await publish(record, existing, signal); checkPreparationSignal(signal); return existing; }
    // A preparation owns its signal. Unrelated consumers never inherit its cancellation.
    const pending = loading.get(key);
    const reusable = pending !== undefined && !pending.signal?.aborted && pending.signal === signal;
    const finish = !waitForTool ? feedback.begin(record, ctx) : undefined;
    const cancelled = () => finish?.({ error: "Cancelled." });
    signal?.addEventListener("abort", cancelled, { once: true });
    const operation = reusable ? pending!.operation : (async () => {
      let result = adapter.headlessActivationTimeoutMs !== undefined && ctx?.mode !== "tui"
        ? await headlessActivation(child => options.loadRecord(record, child), adapter.headlessActivationTimeoutMs, signal)
        : await options.loadRecord(record, signal);
      checkPreparationSignal(signal);
      if (typeof result.body !== "string" || !result.body.trim()) throw hostError("SOURCE_BODY_MISSING");
      if (recordIdentity(result) !== key) throw hostError("SOURCE_IDENTITY_MISMATCH");
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
      if (generation === selectedGeneration) {
        if (record.kind !== "prompt") loaded.set(key, { record: result, owner: preparationOwner });
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
      const outcome = waitForTool && ctx?.hasUI && ctx.mode === "tui" && ctx.ui?.custom
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
        } catch (error) { const restore = gate.active === entry && !entry.controller.signal.aborted; gate.release(entry); if (restore) ctx.ui?.setEditorText?.(entry.event.text ?? text); notify(ctx, error); }
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
      } catch (error) { const restore = gate.active === entry && !entry.controller.signal.aborted; gate.release(entry); if (restore) ctx.ui?.setEditorText?.(entry.event.text ?? ""); notify(ctx, error); }
    },
  });
  for (const event of ["session_before_switch", "session_before_branch", "session_before_tree"] as const) host.on(event, () => {
    generation++;
    lifecycleController.abort();
    lifecycleController = new AbortController();
    gate.cancel();
    turnPrompts = undefined;
    nativeInputs.clear();
  });
  for (const event of ["session_start", "session_switch", "session_tree", "session_branch"] as const) host.on(event, async (_event, ctx) => {
    // A successful host session boundary acknowledges disposal of its pending turn.
    generation++;
    lifecycleController.abort();
    lifecycleController = new AbortController();
    gate.cancel();
    const entry = gate.active;
    if (entry) gate.release(entry);
    handoff = undefined;
    turnPrompts = undefined;
    nativeInputs.clear();
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
    gate.cancel();
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
  api.on("context", event => ({ messages: event.messages.filter(message => message.customType !== ACTIVATION_MESSAGE) }));
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
    try {
      // Cold preparation belongs to the registered command, outside the input hook budget.
      if (entry && adapter.submission.mode === "command") return adapter.transformInput(`/context-broker-submit ${entry.id}`);
      await preflight(text, ctx, entry?.controller.signal);
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
    } catch (error) { const restore = !entry || !entry.controller.signal.aborted && gate.active === entry; if (entry) gate.release(entry); if (restore) ctx.ui?.setEditorText?.(text); notify(ctx, error); return adapter.handledInput; }
    return adapter.continuedInput;
  });
  host.on("before_agent_start", async (event, ctx) => {
    // before_agent_start has no input provenance; only a matching current receipt
    // may activate content. Delegated/bootstrap text is passed through unchanged.
    try { await ready(); }
    catch (error) { ctx.abort?.(); notify(ctx, error); return undefined; }
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
      if (receipt && matches) receipt.entry.controller.abort();
      if (!gate.active || gate.active === receipt?.entry) ctx.abort?.();
      // Keep the sole receipt until the final injection consumer acknowledges it.
      notify(ctx, error);
      return undefined;
    }
    const promptHash = createHash("sha256").update(event.prompt ?? "").digest("hex");
    const native = adapter.submission.receipt === "handoff"
      ? receipt && matches && receipt.native?.promptSha256 === promptHash ? receipt.native.snapshot : undefined
      : nativeInputs.get(promptHash);
    if (native && receipt && matches) receipt.native = { snapshot: native, promptSha256: promptHash };
    const message = native ? {
      customType: "context-broker", content: [], display: false,
      details: { nativePromptSha256: promptHash, records: [{ identity: recordIdentity(native), name: native.name, sourceId: native.sourceId, sourceScope: native.sourceScope, recordId: native.id, loaded: true, snapshotId: native.snapshotId }] },
    } : undefined;
    if (native && adapter.submission.receipt === "input-digest") nativeInputs.delete(promptHash);
    const systemPrompt = viewSystemPrompt(event.systemPrompt, records, defaultRouters, new Set(readRecords.keys()), views, ctx.cwd);
    return { ...(message ? { message } : {}), systemPrompt: adapter.systemPrompt?.(systemPrompt) ?? systemPrompt };
  });
  host.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "read" || !event.input || typeof event.input.path !== "string") return undefined;
    const requested = event.input.path;
    const signal = lifecycleController.signal;
    try { await ready(signal); }
    catch (error) { return { block: true, reason: failure(error) }; }
    let selected: SkillRecord | undefined;
    let suffix = "";
    let reference = "";
    const explicit = requested.startsWith("skill://");
    if (explicit && discoveryError) return { block: true, reason: failure(discoveryError) };
    if (explicit) {
      try {
        const match = /^skill:\/\/([^/?#:]+)(.*)$/.exec(requested);
        if (!match) throw hostError("SOURCE_REFERENCE_INVALID");
        const selector = decodeURIComponent(match[1]!);
        assertSourceAvailable(selector, sourceFailures, true);
        let candidates = [...hostRecords.values()].filter(record => {
          const registered = /^skill:\/\/([^/?#]+)\//.exec(record.ref ?? "");
          return registered && decodeURIComponent(registered[1]!) === selector;
        });
        const active = gate.active?.prepared ?? (turnPrompts?.signal.aborted ? undefined : turnPrompts?.snapshots);
        const scopes = [...(active?.values() ?? [])].filter(record => record.sourceScope !== undefined);
        if (scopes.length) candidates = candidates.filter(record => scopes.some(scope => scope.sourceId === record.sourceId && scope.sourceScope === record.sourceScope));
        if (candidates.length > 1) throw new InvocationError(requested, "ambiguous", candidates);
        selected = candidates[0];
        if (!selected) throw hostError("SOURCE_REFERENCE_MISSING");
        const remainder = match[2]!;
        const colon = remainder.indexOf(":");
        const target = colon < 0 ? remainder : remainder.slice(0, colon);
        suffix = colon < 0 ? "" : remainder.slice(colon);
        if (target && !target.startsWith("/") && !target.startsWith("?")) throw hostError("SOURCE_REFERENCE_INVALID");
        reference = target.startsWith("/") ? target.slice(1) : target;
        const query = reference.indexOf("?");
        const resource = decodeURIComponent(query < 0 ? reference : reference.slice(0, query));
        if (resource && (isAbsolute(resource) || /[:?\\\u0000#]/.test(resource) || resource.split("/").some(part => !part || part === "." || part === ".."))) throw hostError("SOURCE_REFERENCE_INVALID");
        if (query >= 0) decodeURIComponent(reference.slice(query + 1));
        if (reference.includes("#")) throw hostError("SOURCE_REFERENCE_INVALID");
        reference = resource + (query < 0 ? "" : reference.slice(query));
      } catch (error) { return { block: true, reason: failure(error) }; }
    } else {
      for (const [index, record] of readRecords) {
        const spellings = [index, index.startsWith(homedir() + sep) ? `~${index.slice(homedir().length)}` : index];
        const exact = spellings.find((path) => requested === path || requested.startsWith(`${path}:`));
        if (exact) { selected = record; suffix = requested.slice(exact.length); break; }
        const directory = dirname(index);
        const raw = isAbsolute(requested) || requested.startsWith("~/") ? requested : join(ctx.cwd ?? process.cwd(), requested);
        const expanded = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
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
    if (reference.includes("?")) {
      const [path, query] = reference.split("?");
      const snapshot = new URLSearchParams(query).get("snapshot");
      const prepared = gate.active?.prepared.get(recordIdentity(selected)) ?? (turnPrompts?.signal.aborted ? undefined : turnPrompts?.snapshots.get(recordIdentity(selected))) ?? loaded.get(recordIdentity(selected))?.record;
      if (snapshot && prepared?.snapshotId !== snapshot) return { block: true, reason: "Requested snapshot is unavailable in the active invocation" };
      reference = path ?? "";
    }
    try {
      const snapshot = gate.active?.prepared.get(recordIdentity(selected)) ?? (turnPrompts?.signal.aborted ? undefined : turnPrompts?.snapshots.get(recordIdentity(selected))) ?? loaded.get(recordIdentity(selected))?.record ?? await activate(selected, ctx, signal, true);
      let path = reference && reference !== (selected.entrypoint ?? "SKILL.md") ? resolve(dirname(snapshot.path), reference) : snapshot.path;
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
      const updated = { ...event.input, path: path + suffix };
      Object.assign(event.input, updated);
      return adapter.updatedRead(updated);
    } catch (error) { return { block: true, reason: failure(error) }; }
  });

  const initialMetadata = refresh();
  if (adapter.metadataDiscovery !== "deferred") await initialMetadata;
  return { invalidate() { metadataGeneration++; metadataController.abort(); generation++; lifecycleController.abort(); lifecycleController = new AbortController(); gate.cancel(); turnPrompts = undefined; }, refresh, activate, prepare, withPreparedPrompt: async (prompt, ctx, build) => {
    const receipt = handoff?.prompts.includes(prompt) ? handoff : undefined;
    try {
      if (receipt) gate.assertCurrent(receipt.entry, ctx);
      const native = receipt?.consumed && receipt.native?.promptSha256 === createHash("sha256").update(prompt).digest("hex") ? receipt.native.snapshot : undefined;
      const result = await build(receipt?.entry.controller.signal, native, receipt?.entry.event.text);
      if (receipt) gate.assertCurrent(receipt.entry, ctx);
      return result;
    } catch (error) {
      if (receipt) receipt.entry.controller.abort();
      if (receipt && (!gate.active || gate.active === receipt.entry)) ctx.abort?.();
      // An old consumer must never abort the next submission.
      if (receipt) gate.release(receipt.entry);
      throw error;
    }
  }, viewStatus: () => views, isNativeLoaded: (messages, record) => messages.some(message => {
    if (message.role !== "custom" || message.customType !== "skill-prompt" || !message.details || typeof message.details !== "object") return false;
    const path = (message.details as Record<string, unknown>).path;
    const selected = typeof path === "string" ? readRecords.get(resolve(path)) : undefined;
    return selected !== undefined && recordIdentity(selected) === recordIdentity(record);
  }) };
}
