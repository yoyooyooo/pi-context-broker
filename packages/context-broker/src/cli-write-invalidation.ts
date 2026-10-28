import { hostCliScope } from "./host-command";
import type { ExtensionAPI, ExtensionContext, MessageContent, SkillRecord, SourceConfig } from "./types";

type NotionSource = Extract<SourceConfig, { type: "notion" }>;
type WriteKind = "content" | "upstream" | "local";
type Invocation = { kind: WriteKind; sources: NotionSource[]; database?: string; consumed: boolean; progress: boolean; progressOperationId?: string };
type ChangedTarget = { database: string; scope: string };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = (value: unknown): string | undefined => typeof value === "string" && /^(?:[a-f\d]{32}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/i.test(value) ? value.replaceAll("-", "").toLowerCase() : undefined;
const scope = (value: unknown): string | undefined => typeof value === "string" && /^[a-f\d]{64}$/.test(value) ? value : undefined;

/** Decode one literal shell argv. Compound commands and expansions have no single CLI receipt owner. */
function literalArgv(command: string): string[] | undefined {
  command = command.trim();
  const result: string[] = [];
  let word = "", started = false, quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (char === "\\") {
      const next = command[++index];
      if (next === undefined || next === "\n") return undefined;
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) word += "\\";
      word += next;
      started = true;
    } else if (char === quote) quote = undefined;
    else if (char === "$" || char === "`" || char === "\0") return undefined;
    else if (quote === '"') word += char;
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === "\n" || char === "\r") return undefined;
    else if (/\s/.test(char)) {
      if (started) { result.push(word); word = ""; started = false; }
    } else if (/[;&|<>(){}*?\[~]/.test(char) || char === "#" && !started) return undefined;
    else { word += char; started = true; }
  }
  if (quote) return undefined;
  if (started) result.push(word);
  return result.length ? result : undefined;
}

function invocation(command: string, sources: NotionSource[]): Invocation | undefined {
  const argv = literalArgv(command);
  if (!argv) return undefined;
  const matching = sources.flatMap(source => {
    try {
      const prefix = hostCliScope([source]).command;
      return prefix.every((value, index) => argv[index] === value) ? [{ source, length: prefix.length }] : [];
    } catch { return []; }
  });
  if (!matching.length || new Set(matching.map(item => item.length)).size !== 1) return undefined;
  const args = argv.slice(matching[0]!.length);
  if (args.some(arg => ["--dry-run", "--help", "-h"].includes(arg))) return undefined;
  const kind: WriteKind | undefined = ["create", "apply", "write", "update"].includes(args[0] ?? "") ? "content"
    : args[0] === "sync" && args[1] === "upstream" && ["run", "connect"].includes(args[2] ?? "") ? "upstream"
    : args[0] === "sync" && args[1] === "local" && ["run", "connect", "apply"].includes(args[2] ?? "") ? "local" : undefined;
  if (!kind) return undefined;
  let database: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg !== "--database" && !arg.startsWith("--database=")) continue;
    if (database !== undefined) return undefined;
    database = arg === "--database" ? args[++index] : arg.slice("--database=".length);
    if (!database || database.startsWith("--")) return undefined;
  }
  return { kind, sources: matching.map(item => item.source), database, consumed: false, progress: argv.includes("--progress") };
}

function changedTargets(value: unknown, kind: WriteKind): ChangedTarget[] {
  const result = object(value);
  if (result.ok !== true || result.dry_run === true) return [];
  const target = (database: unknown, auth: unknown): ChangedTarget[] => {
    const id = uuid(database), identity = scope(auth);
    return id && identity ? [{ database: id, scope: identity }] : [];
  };
  if (kind === "content") {
    if (result.verified !== true || result.reused === true || ["unchanged", "reuse"].includes(String(result.action))) return [];
    const properties = object(result.effects).properties;
    const written = result.operation === "update"
      // update reports the property PATCH that actually ran; it currently has no semantic no-op branch.
      ? Array.isArray(properties) && properties.length > 0 && properties.every(value => typeof value === "string" && value.length > 0)
      : result.reused === false && ["create", "replace", "write"].includes(String(result.operation)) && ["create", "update"].includes(String(result.action));
    if (!written) return [];
    const locator = object(object(result.record).locator);
    return locator.type === "notion_page" && uuid(locator.page_id) ? target(locator.database_id, result.scope) : [];
  }
  if (kind === "upstream") {
    if (result.verified !== true || !Array.isArray(result.results)) return [];
    return result.results.flatMap(value => {
      const item = object(value), operation = object(item.operation), members = object(item.members);
      const counts = [members.created, members.updated, members.restored];
      if (operation.state !== "verified" || item.error_code || !counts.every(count => Number.isSafeInteger(count) && (count as number) >= 0) || !counts.some(count => (count as number) > 0)) return [];
      // operation.database_id is the subscription library, not the changed content library.
      return target(operation.target_database_id, operation.scope);
    });
  }
  const changedBindings = (value: unknown): ChangedTarget[] => !Array.isArray(value) ? [] : value.flatMap(value => {
    const binding = object(value);
    return binding.action === "push" && binding.verified === true && binding.stage === "complete" && uuid(binding.page_id)
      ? target(binding.database_id, binding.scope) : [];
  });
  if (result.mode === "run") {
    if (result.verified !== true || result.outcome !== "complete" || !Array.isArray(result.targets)) return [];
    return result.targets.flatMap(value => {
      const item = object(value);
      return item.phase === "verified" && item.verified === true && !item.failure ? changedBindings(item.bindings) : [];
    });
  }
  return result.verified === true ? changedBindings(result.bindings) : [];
}

function affectedSources(call: Invocation, result: unknown, records: SkillRecord[]): string[] {
  const targets = changedTargets(result, call.kind);
  const selectedDatabase = uuid(call.database);
  return call.sources.filter(source => targets.some(target => {
    if (selectedDatabase && selectedDatabase !== target.database) return false;
    const known = records.filter(record => record.sourceId === source.id);
    const scopes = known.flatMap(record => record.sourceScope ? [record.sourceScope] : []);
    if (scopes.length && !scopes.includes(target.scope)) return false;
    if (!source.database) return true;
    const configured = uuid(source.database);
    if (configured) return configured === target.database;
    if (source.database === call.database) return true;
    return known.some(record => record.sourceScope === target.scope && record.locator && record.locator.type !== "local" &&
      uuid(record.locator.type === "notion_subscription" ? record.locator.target_database_id : record.locator.database_id) === target.database);
  })).map(source => source.id);
}

function text(content: MessageContent | undefined): string {
  return typeof content === "string" ? content : (content ?? []).filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n");
}

export type CliOutput = { status: "complete"; result: Record<string, unknown> }
  | { status: "pending"; operationId?: string; artifact?: string }
  | { status: "invalid" };

/** CLI stdout is one final JSON object; --progress stderr is PublicationProgress JSONL. */
export function decodeCliWriteOutput(body: string, options: { progress?: boolean; operationId?: string } = {}): CliOutput {
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const progressFields = new Set(["operation_id", "stage", "status", "elapsed_ms", "stage_ms"]);
  const sqliteWarning = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time$/;
  const sqliteHint = "(Use `node --trace-warnings ...` to show where the warning was created)";
  const complete = (result: Record<string, unknown>, operationId?: string): CliOutput => operationId !== undefined && result.operation_id !== operationId
    ? { status: "invalid" } : { status: "complete", result };
  try {
    const result = object(JSON.parse(body));
    if (typeof result.ok === "boolean") return complete(result, options.operationId);
  } catch { /* A host can merge stdout with progress and Node's SQLite warning. */ }
  const footer = /\n\n\[Some lines truncated to \d+ bytes\. Use (artifact:\/\/[a-z\d_-]+):raw:\d+-\d+ to read lines? \d+(?:-\d+)? whole\]\s*$/i.exec(body);
  const lines = (footer ? body.slice(0, footer.index) : body).split(/\r?\n/);
  let final: Record<string, unknown> | undefined;
  let operationId = options.operationId;
  let truncated = 0;
  let warningHint = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (sqliteWarning.test(line)) { warningHint = true; continue; }
    if (line === sqliteHint) {
      if (!warningHint) return { status: "invalid" };
      warningHint = false;
      continue;
    }
    warningHint = false;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch {
      // Only the host's observed truncation footer can authorize an artifact follow-up.
      // The prefix itself never proves that the operation completed.
      if (footer && line.startsWith("{") && line.endsWith("…")) { truncated++; continue; }
      return { status: "invalid" };
    }
    const item = object(value);
    if (typeof item.ok === "boolean") {
      if (final) return { status: "invalid" };
      final = item;
      continue;
    }
    if (options.progress !== true || Object.keys(item).length !== progressFields.size || !Object.keys(item).every(key => progressFields.has(key)) ||
        typeof item.operation_id !== "string" || !item.operation_id.trim() || typeof item.stage !== "string" || !item.stage.trim() ||
        typeof item.status !== "string" || !["started", "completed", "failed"].includes(item.status) ||
        typeof item.elapsed_ms !== "number" || !Number.isFinite(item.elapsed_ms) || item.elapsed_ms < 0 ||
        typeof item.stage_ms !== "number" || !Number.isFinite(item.stage_ms) || item.stage_ms < 0) return { status: "invalid" };
    if (operationId !== undefined && operationId !== item.operation_id) return { status: "invalid" };
    operationId = item.operation_id;
  }
  if (footer) {
    // Multiple truncated objects or an additional final object cannot establish one final receipt.
    if (truncated !== 1 || final) return { status: "invalid" };
    return { status: "pending", operationId, artifact: footer[1] };
  }
  return final ? complete(final, operationId) : { status: "pending", operationId };
}

/** Observe existing host tools; never execute CLI commands or invalidate an active submission. */
export function installCliWriteInvalidation(api: ExtensionAPI, options: {
  sources: SourceConfig[];
  records(): SkillRecord[];
  changed(sourceIds: string[], ctx: ExtensionContext): void;
}): void {
  const sources = options.sources.filter((source): source is NotionSource => source.type === "notion" && source.enabled !== false);
  const calls = new Map<string, Invocation>();
  const artifacts = new Map<string, Invocation>();
  const key = (id: string, ctx: ExtensionContext) => JSON.stringify([ctx.sessionManager?.getSessionId?.(), id]);
  const retain = (map: Map<string, Invocation>, id: string, call: Invocation) => {
    map.set(id, call);
    if (map.size > 128) map.delete(map.keys().next().value!);
  };
  api.on("tool_call", (event, ctx): undefined => {
    if (!event.toolCallId) return;
    let call: Invocation | undefined;
    if (event.toolName === "bash" && typeof event.input.command === "string") call = invocation(event.input.command, sources);
    if (event.toolName === "read" && typeof event.input.path === "string") {
      const artifact = /^artifact:\/\/[a-z\d_-]+/i.exec(event.input.path)?.[0];
      if (artifact) call = artifacts.get(key(artifact, ctx));
    }
    if (call && !call.consumed) retain(calls, key(event.toolCallId, ctx), call);
  });
  api.on("tool_result", (event, ctx) => {
    if (!event.toolCallId) return;
    const id = key(event.toolCallId, ctx), call = calls.get(id);
    calls.delete(id);
    if (!call || call.consumed || event.isError) return;
    const output = decodeCliWriteOutput(text(event.content), { progress: call.progress, operationId: call.progressOperationId });
    if (output.status === "pending") {
      call.progressOperationId = output.operationId;
      if (output.artifact) retain(artifacts, key(output.artifact, ctx), call);
      return;
    }
    call.consumed = true;
    for (const [artifact, owner] of artifacts) if (owner === call) artifacts.delete(artifact);
    if (output.status !== "complete") return;
    const ids = affectedSources(call, output.result, options.records());
    if (ids.length) options.changed(ids, ctx);
  });
  for (const event of ["session_shutdown", "session_switch", "session_tree", "session_branch"] as const) api.on(event, () => { calls.clear(); artifacts.clear(); });
}
