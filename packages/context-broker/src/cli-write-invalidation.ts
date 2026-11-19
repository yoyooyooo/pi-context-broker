import { hostCliScope } from "./host-command";
import { validSharedIdentity } from "./shared-skill-identity";
import type { ExtensionAPI, ExtensionContext, MessageContent, SkillRecord, SourceConfig } from "./types";

type NotionSource = Extract<SourceConfig, { type: "notion" }>;
type Invocation = { entry: string; skillId: string; sources: NotionSource[] }
  & ({ kind: "apply"; operationId?: string } | { kind: "resume"; operationId: string });
type Library = { libraryId: string; databaseId: string; dataSourceId: string };
type SourceBinding = { source: NotionSource } & (
  | { kind: "unknown" }
  | { kind: "invalid" }
  | { kind: "known"; library: Library; pages: Map<string, string> }
);
type CurrentWrite = { library: Library; pageId: string; status: "applied" | "unchanged" };
type CallState = { kind: "pending"; command: string; invocation: Invocation } | { kind: "settled" };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): string | undefined => typeof value === "string" && /^(?:[a-f\d]{32}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/i.test(value) ? value.replaceAll("-", "").toLowerCase() : undefined;
const sameLibrary = (left: Library, right: Library) => left.libraryId === right.libraryId && left.databaseId === right.databaseId && left.dataSourceId === right.dataSourceId;
const booleanLiteral = (value: string | undefined): boolean | undefined => value === undefined ? undefined
  : ["true", "yes", "on", "1", "y"].includes(value) ? true : ["false", "no", "off", "0", "n"].includes(value) ? false : undefined;
// Effect's Int CLI primitive first accepts a finite decimal/exponent string.
const positiveInteger = (value: string) => /^[+-]?\d*\.?\d+(?:[Ee][+-]?\d+)?$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

/** Match current Notion URL host/path boundaries; aliases remain exact strings. */
function entryId(value: unknown): string | undefined {
  const id = uuid(value);
  if (id || typeof value !== "string") return id;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || !/(^|\.)notion\.(com|site|so)$/.test(url.hostname)) return undefined;
    return uuid(/([a-f\d]{32})\/?$/i.exec(url.pathname)?.[1]);
  } catch { return undefined; }
}

/** Decode one literal shell argv. Expansions and compound commands have no single owner. */
function literalArgv(command: string): string[] | undefined {
  command = command.trim();
  const result: string[] = [];
  let word = "", started = false, quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (char === "\0" || char === "\n" || char === "\r") return undefined;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (char === "\\") {
      const next = command[++index];
      if (next === undefined || ["\n", "\r", "\0"].includes(next)) return undefined;
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) word += "\\";
      word += next;
      started = true;
    } else if (char === quote) quote = undefined;
    else if (char === "$" || char === "`") return undefined;
    else if (quote === '"') word += char;
    else if (char === "'" || char === '"') { quote = char; started = true; }
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
  if (!argv || !sources.length) return undefined;
  let prefix: string[];
  try { prefix = hostCliScope().command; } catch { return undefined; }
  if (!prefix.every((value, index) => argv[index] === value)) return undefined;
  const args = argv.slice(prefix.length);
  if (args[0] !== "ctl" || args[1] !== "library" || args[2] !== "import") return undefined;
  const values = new Map<string, string>();
  const singleton = new Set(["entry", "skill-id", "operation", "name", "description", "max-requests", "max-bytes", "timeout"]);
  let input: string | undefined;
  for (let index = 3; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      const operands = args.slice(index + 1);
      if (operands.length > 1 || operands.length === 1 && (input !== undefined || !operands[0])) return undefined;
      input ??= operands[0];
      break;
    }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      let name = arg.slice(2, equal < 0 ? undefined : equal);
      const negated = name === "no-resume" || name === "no-dry-run";
      if (negated) name = name.slice(3);
      if (values.has(name)) return undefined;
      if (name === "resume" || name === "dry-run") {
        const next = booleanLiteral(args[index + 1]);
        if (negated && (equal >= 0 || next !== undefined)) return undefined;
        const value = negated ? false : equal >= 0 ? booleanLiteral(arg.slice(equal + 1)) : next ?? true;
        if (value === undefined) return undefined;
        if (!negated && equal < 0 && next !== undefined) index++;
        values.set(name, String(value));
        continue;
      }
      if (!singleton.has(name)) return undefined;
      const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
      if (value === undefined || equal < 0 && value.startsWith("--") || !value.length && name !== "description" && name !== "name") return undefined;
      if (["max-requests", "max-bytes", "timeout"].includes(name) && !positiveInteger(value)) return undefined;
      values.set(name, value);
    } else {
      if (arg.startsWith("-") || !arg.length || input !== undefined) return undefined;
      input = arg;
    }
  }
  const entry = values.get("entry"), skillId = values.get("skill-id"), operationId = values.get("operation");
  if (input === undefined || !entry?.trim() || entry.startsWith("notion_page:") || !validSharedIdentity(skillId) || operationId !== undefined && !validSharedIdentity(operationId)) return undefined;
  if (values.get("dry-run") === "true") return undefined;
  if (values.get("resume") === "true") return operationId === undefined ? undefined : { kind: "resume", entry, skillId, operationId, sources };
  return { kind: "apply", entry, skillId, operationId, sources };
}

function library(value: unknown): Library | undefined {
  if (!isObject(value) || !validSharedIdentity(value.library_id)) return undefined;
  const databaseId = uuid(value.database_id), dataSourceId = uuid(value.data_source_id);
  return databaseId && dataSourceId ? { libraryId: value.library_id, databaseId, dataSourceId } : undefined;
}

function sourceBinding(source: NotionSource, records: SkillRecord[]): SourceBinding {
  let known: Library | undefined;
  const pages = new Map<string, string>();
  for (const record of records) {
    if (record.sourceId !== source.id || record.locator?.type !== "shared_skill") continue;
    const current = library(record.locator), page = uuid(record.locator.page_id), skill = record.locator.skill_id;
    if (!current || !page || !validSharedIdentity(skill) || known && !sameLibrary(known, current) || pages.has(skill) && pages.get(skill) !== page) return { kind: "invalid", source };
    known = current;
    pages.set(skill, page);
  }
  const configured = entryId(source.database);
  if (known && configured && known.databaseId !== configured) return { kind: "invalid", source };
  return known ? { kind: "known", source, library: known, pages } : { kind: "unknown", source };
}

function operationMatches(call: Invocation, value: Record<string, unknown>): boolean {
  return validSharedIdentity(value.operation_id) && value.skill_id === call.skillId && (call.operationId === undefined || value.operation_id === call.operationId);
}

function currentWrite(call: Invocation, result: Record<string, unknown>): CurrentWrite | undefined {
  if (result.ok !== true || result.contract !== "current" || result.state !== "ready" || result.dry_run === true ||
      result.status !== "applied" && result.status !== "unchanged" || !operationMatches(call, result) ||
      typeof result.input_sha256 !== "string" || !/^[a-f\d]{64}$/.test(result.input_sha256) ||
      typeof result.files !== "number" || !Number.isSafeInteger(result.files) || result.files < 1) return undefined;
  const owner = library(result.library), pageId = uuid(result.page_id);
  return owner && pageId ? { library: owner, pageId, status: result.status } : undefined;
}

function successfulSources(call: Invocation, result: CurrentWrite, bindings: SourceBinding[]): string[] {
  const database = entryId(call.entry);
  if (database && database !== result.library.databaseId) return [];
  const matching = bindings.filter(binding => {
    if (binding.kind === "invalid") return false;
    const configured = entryId(binding.source.database);
    if (configured && configured !== result.library.databaseId) return false;
    if (binding.kind === "known") return sameLibrary(binding.library, result.library) &&
      (!binding.pages.has(call.skillId) || binding.pages.get(call.skillId) === result.pageId);
    return configured === result.library.databaseId || binding.source.database === call.entry;
  });
  // Aliases are exact configured entries, never display names or an inferred CLI alias.
  if (!database && !matching.some(binding => binding.source.database === call.entry)) return [];
  return matching.map(binding => binding.source.id);
}

/** An unknown write can require a reread without proving completion or another mutation. */
function entrySources(call: Invocation, bindings: SourceBinding[]): string[] {
  const selected = entryId(call.entry);
  if (selected) return bindings.filter(binding => binding.kind !== "invalid" &&
    (entryId(binding.source.database) === selected || binding.kind === "known" && binding.library.databaseId === selected)).map(binding => binding.source.id);
  const exact = bindings.filter(binding => binding.kind !== "invalid" && binding.source.database === call.entry);
  const known = exact.flatMap(binding => binding.kind === "known" ? [binding.library] : []);
  if (known.some(value => !sameLibrary(value, known[0]!))) return [];
  const owner = known[0];
  return bindings.filter(binding => exact.includes(binding) || owner && binding.kind !== "invalid" &&
    (binding.kind === "known" ? sameLibrary(binding.library, owner) : entryId(binding.source.database) === owner.databaseId)).map(binding => binding.source.id);
}

function affectedSources(call: Invocation, output: CliOutput, records: SkillRecord[]): string[] {
  if (output.status === "invalid") return [];
  const bindings = call.sources.map(source => sourceBinding(source, records));
  if (output.status === "truncated") return entrySources(call, bindings);
  const result = output.result;
  if (result.ok === false) {
    const error = result.error;
    return isObject(error) && isObject(error.details) && operationMatches(call, error.details) ? entrySources(call, bindings) : [];
  }
  const written = currentWrite(call, result);
  return written && (written.status === "applied" || call.kind === "resume") ? successfulSources(call, written, bindings) : [];
}

function text(content: MessageContent | undefined): string {
  return typeof content === "string" ? content : (content ?? []).flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

export type CliOutput = { status: "complete"; result: Record<string, unknown> } | { status: "truncated" } | { status: "invalid" };

/** One final JSON object, optionally merged with the observed Node SQLite warning. */
export function decodeCliWriteOutput(body: string): CliOutput {
  const parse = (value: string): Record<string, unknown> | undefined => {
    try { const parsed: unknown = JSON.parse(value); return isObject(parsed) && typeof parsed.ok === "boolean" ? parsed : undefined; }
    catch { return undefined; }
  };
  const complete = parse(body);
  if (complete) return { status: "complete", result: complete };
  const sqliteWarning = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time$/;
  const sqliteHint = "(Use `node --trace-warnings ...` to show where the warning was created)";
  const lines: string[] = [];
  let warning = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (sqliteWarning.test(line)) { warning = true; continue; }
    if (line === sqliteHint) {
      if (!warning) return { status: "invalid" };
      warning = false;
      continue;
    }
    warning = false;
    lines.push(raw);
  }
  const cleaned = lines.join("\n").trim(), result = parse(cleaned);
  if (result) return { status: "complete", result };
  // Only the actual host footer permits a conservative reread. Never follow its artifact.
  const footer = /\n\n\[Some lines truncated to \d+ bytes\. Use artifact:\/\/[a-z\d_-]+:raw:\d+-\d+ to read lines? \d+(?:-\d+)? whole\]$/.exec(cleaned);
  if (!footer) return { status: "invalid" };
  const prefix = cleaned.slice(0, footer.index).trim();
  return /^\{\s*"ok"\s*:\s*(?:true|false)\s*,[^\r\n]*…$/.test(prefix) ? { status: "truncated" } : { status: "invalid" };
}

/** Observe existing bash calls; never run the CLI, follow artifacts or change an active submission. */
export function installCliWriteInvalidation(api: ExtensionAPI, options: {
  sources: SourceConfig[];
  records(): SkillRecord[];
  changed(sourceIds: string[], ctx: ExtensionContext): void;
}): void {
  const sources = options.sources.filter((source): source is NotionSource => source.type === "notion" && source.enabled !== false);
  const calls = new Map<string, CallState>();
  const key = (id: string | undefined, ctx: ExtensionContext): string | undefined => {
    const session = ctx.sessionManager?.getSessionId?.();
    return id && session ? JSON.stringify([session, id]) : undefined;
  };
  const retain = (id: string, state: CallState) => {
    calls.set(id, state);
    const oldest = calls.keys().next();
    if (calls.size > 128 && !oldest.done) calls.delete(oldest.value);
  };
  api.on("tool_call", (event, ctx): undefined => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    const id = key(event.toolCallId, ctx);
    if (!id) return;
    const previous = calls.get(id);
    if (previous) {
      if (previous.kind === "pending" && previous.command !== event.input.command) retain(id, { kind: "settled" });
      return;
    }
    const call = invocation(event.input.command, sources);
    if (call) retain(id, { kind: "pending", command: event.input.command, invocation: call });
  });
  api.on("tool_result", (event, ctx) => {
    if (event.toolName !== "bash") return;
    const id = key(event.toolCallId, ctx), state = id ? calls.get(id) : undefined;
    if (!id || state?.kind !== "pending") return;
    retain(id, { kind: "settled" });
    if (typeof event.input.command === "string" && event.input.command !== state.command) return;
    const output = decodeCliWriteOutput(text(event.content));
    const ids = affectedSources(state.invocation, output, options.records());
    if (ids.length) options.changed([...new Set(ids)], ctx);
  });
  for (const event of ["session_shutdown", "session_switch", "session_tree", "session_branch"] as const) api.on(event, () => { calls.clear(); });
}
