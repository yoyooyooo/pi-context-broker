import { notionPageId } from "./native-reference";
import { hostCliScope } from "./host-command";
import { validSharedIdentity } from "./shared-skill-identity";
import type { ExtensionAPI, ExtensionContext, MessageContent, SkillRecord, SourceConfig } from "./types";

type NotionSource = Extract<SourceConfig, { type: "notion" }>;
type InvocationTarget = { route: "import"; skillId: string }
  | { route: "source-apply" }
  | { route: "source-refresh" | "source-enable" | "source-disable" | "source-remove"; sourceId: string }
  | { route: "source-takeover"; sourceId: string; skillId: string; fileId: string; sourcePath: string; to: "native" | "resource" }
  | { route: "source-restore-follow"; sourceId: string; skillId: string; fileId: string; sourcePath: string };
type InvocationScope = { library: string; sources: NotionSource[] };
type OperationInvocation = InvocationScope & InvocationTarget
  & ({ kind: "apply"; operationId?: string } | { kind: "resume"; operationId: string }
    | { kind: "supersede"; operationId: string; predecessor: string });
type NativeSkillTarget = { kind: "skill"; skillId: string } | { kind: "page"; pageId: string };
type NativeSkillInvocation = InvocationScope & { route: "skill"; kind: "native" } & (
  | { action: "create"; target: Extract<NativeSkillTarget, { kind: "skill" }> }
  | { action: "update"; target: NativeSkillTarget }
  | { action: "remove"; target: NativeSkillTarget }
  | { action: "register"; target: Extract<NativeSkillTarget, { kind: "page" }>; skillId?: string }
);
type Invocation = OperationInvocation | NativeSkillInvocation;
type Library = { libraryId: string; databaseId: string; dataSourceId: string };
type SourceBinding = { source: NotionSource } & (
  | { kind: "unknown" }
  | { kind: "invalid" }
  | { kind: "known"; library: Library; pages: Map<string, string> }
);
type CurrentSkillWrite = { library: Library; skillId: string; pageId: string; status: "applied" | "unchanged" };
type CurrentWrite = { library: Library; pages: ReadonlyMap<string, string>; status: "applied" | "unchanged" | "removed" };
type CallState = { kind: "pending"; command: string; invocation: Invocation } | { kind: "settled" };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): string | undefined => typeof value === "string" && /^(?:[a-f\d]{32}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/i.test(value) ? value.replaceAll("-", "").toLowerCase() : undefined;
const sameLibrary = (left: Library, right: Library) => left.libraryId === right.libraryId && left.databaseId === right.databaseId && left.dataSourceId === right.dataSourceId;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{64}$/.test(value);
const sourceIdentity = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)
  && !/^(?:snapshot-|bundle-|source-plan-)/.test(value) && !/^source-[a-f\d]{64}$/.test(value);
const booleanLiteral = (value: string | undefined): boolean | undefined => value === undefined ? undefined
  : ["true", "yes", "on", "1", "y"].includes(value) ? true : ["false", "no", "off", "0", "n"].includes(value) ? false : undefined;
// Effect's Int CLI primitive first accepts a finite decimal/exponent string.
const positiveInteger = (value: string) => /^[+-]?\d*\.?\d+(?:[Ee][+-]?\d+)?$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

/** Root selectors use the same strict Notion URL/ID boundary as Source config. */
const libraryId = (value: unknown): string | undefined => typeof value === "string" ? notionPageId(value)?.replaceAll("-", "") : undefined;

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

function nativeSkillTarget(value: string): NativeSkillTarget | undefined {
  const pageId = libraryId(value);
  return pageId ? { kind: "page", pageId } : validSharedIdentity(value) ? { kind: "skill", skillId: value } : undefined;
}

const skillPath = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && !/[\\\u0000-\u001f\u007f-\u009f]/u.test(value) && !/^[a-z]:/i.test(value)
  && value.split("/").every(part => part !== "" && part !== "." && part !== "..");

/** Native commands own their automatic operation and accept no recovery flags. */
function nativeSkillInvocation(args: string[], sources: NotionSource[]): NativeSkillInvocation | undefined {
  const action = args[3];
  if (action !== "create" && action !== "update" && action !== "register" && action !== "remove") return undefined;
  const singleton = new Set(["library", "max-requests", "max-bytes", "timeout",
    ...(action === "remove" ? [] : ["name", "description", "enabled", "default-context"]),
    ...(action === "create" || action === "register" ? ["skill-id"] : []),
    ...(action === "update" ? ["input", "path"] : [])]);
  const repeatable = new Set([...(action === "create" || action === "update" ? ["members", "requires"] : []),
    ...(action === "update" ? ["file", "remove-file"] : [])]);
  const values = new Map<string, string>(), repeated = new Map<string, string[]>(), operands: string[] = [];
  for (let index = 4; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") { operands.push(...args.slice(index + 1)); break; }
    if (!arg.startsWith("--")) {
      if (!arg.length || arg.startsWith("-")) return undefined;
      operands.push(arg); continue;
    }
    const equal = arg.indexOf("="), rawName = arg.slice(2, equal < 0 ? undefined : equal);
    const name = rawName === "no-dry-run" ? "dry-run" : rawName;
    if (values.has(name)) return undefined;
    if (name === "dry-run") {
      const next = booleanLiteral(args[index + 1]), negated = rawName === "no-dry-run";
      if (negated && (equal >= 0 || next !== undefined)) return undefined;
      const value = negated ? false : equal >= 0 ? booleanLiteral(arg.slice(equal + 1)) : next ?? true;
      if (value === undefined) return undefined;
      if (!negated && equal < 0 && next !== undefined) index++;
      values.set(name, String(value)); continue;
    }
    if (!singleton.has(name) && !repeatable.has(name)) return undefined;
    const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
    if (value === undefined || equal < 0 && value.startsWith("--") || !value.length && !["description", "members", "requires"].includes(name)) return undefined;
    if (["max-requests", "max-bytes", "timeout"].includes(name) && !positiveInteger(value)) return undefined;
    if ((name === "enabled" || name === "default-context") && value !== "true" && value !== "false") return undefined;
    if (repeatable.has(name)) repeated.set(name, [...(repeated.get(name) ?? []), value]);
    else values.set(name, value);
  }
  const library = values.get("library"), input = operands[0];
  if (operands.length !== 1 || !input || !library?.trim() || /^notion_page:/i.test(library) || values.get("dry-run") === "true") return undefined;
  for (const name of ["members", "requires"]) {
    const targets = repeated.get(name) ?? [];
    if (targets.length === 1 && targets[0] === "") continue;
    if (new Set(targets).size !== targets.length || targets.some(value => !nativeSkillTarget(value))) return undefined;
  }
  const paths = new Set<string>();
  for (const file of repeated.get("file") ?? []) {
    const at = file.indexOf("="), path = file.slice(0, at);
    if (at < 1 || at === file.length - 1 || !skillPath(path) || paths.has(path)) return undefined;
    paths.add(path);
  }
  for (const path of repeated.get("remove-file") ?? []) {
    if (!skillPath(path) || paths.has(path)) return undefined;
    paths.add(path);
  }
  const selectedPath = values.get("path");
  if (selectedPath !== undefined && (!values.has("input") || !skillPath(selectedPath) || paths.has(selectedPath))) return undefined;
  if (action === "update" && !["input", "name", "description", "enabled", "default-context"].some(name => values.has(name))
      && repeated.size === 0) return undefined;
  if (action === "create") {
    const skillId = values.get("skill-id");
    return validSharedIdentity(skillId) ? { route: "skill", kind: "native", action, target: { kind: "skill", skillId }, library, sources } : undefined;
  }
  const target = nativeSkillTarget(input);
  if (!target) return undefined;
  if (action === "register") {
    const skillId = values.get("skill-id");
    return target.kind === "page" && (skillId === undefined || validSharedIdentity(skillId))
      ? { route: "skill", kind: "native", action, target, skillId, library, sources } : undefined;
  }
  return { route: "skill", kind: "native", action, target, library, sources };
}

function invocation(command: string, sources: NotionSource[]): Invocation | undefined {
  const argv = literalArgv(command);
  if (!argv || !sources.length) return undefined;
  let prefix: string[];
  try { prefix = hostCliScope().command; } catch { return undefined; }
  if (!prefix.every((value, index) => argv[index] === value)) return undefined;
  const args = argv.slice(prefix.length);
  if (args[0] !== "ctl" || args[1] !== "library") return undefined;
  if (args[2] === "skill") return nativeSkillInvocation(args, sources);
  let route: InvocationTarget["route"];
  if (args[2] === "import") route = "import";
  else if (args[2] === "source") {
    switch (args[3]) {
      case "apply": route = "source-apply"; break;
      case "refresh": route = "source-refresh"; break;
      case "enable": route = "source-enable"; break;
      case "disable": route = "source-disable"; break;
      case "remove": route = "source-remove"; break;
      case "takeover": route = "source-takeover"; break;
      case "restore-follow": route = "source-restore-follow"; break;
      default: return undefined;
    }
  } else return undefined;
  const fileAction = route === "source-takeover" || route === "source-restore-follow";
  const values = new Map<string, string>();
  const singleton = new Set(["library", "operation", "supersede", "max-requests", "max-bytes", "timeout",
    ...(route === "import" ? ["skill-id", "name", "description"] : fileAction ? ["skill-id", "file-id"] : []),
    ...(route === "source-takeover" ? ["as"] : [])]);
  const native = new Set<string>(), operands: string[] = [];
  for (let index = route === "import" ? 3 : 4; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      const remaining = args.slice(index + 1);
      if (remaining.some(value => !value.length)) return undefined;
      operands.push(...remaining);
      break;
    }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      let name = arg.slice(2, equal < 0 ? undefined : equal);
      const negated = name === "no-resume" || name === "no-dry-run";
      if (negated) name = name.slice(3);
      if (name === "native") {
        if (route !== "import") return undefined;
        const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
        if (value === undefined || !value.length || equal < 0 && value.startsWith("--") || native.has(value)) return undefined;
        native.add(value);
        continue;
      }
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
      if (arg.startsWith("-") || !arg.length) return undefined;
      operands.push(arg);
    }
  }
  const library = values.get("library"), operationId = values.get("operation"), predecessor = values.get("supersede");
  const input = operands[0];
  if (operands.length !== (fileAction ? 2 : 1) || input === undefined || !library?.trim() || library.startsWith("notion_page:") || operationId !== undefined && !validSharedIdentity(operationId)) return undefined;
  let target: InvocationTarget;
  if (route === "import") {
    const skillId = values.get("skill-id");
    if (!validSharedIdentity(skillId)) return undefined;
    target = { route, skillId };
  } else if (route === "source-apply") target = { route };
  else {
    if (!sourceIdentity(input)) return undefined;
    if (route === "source-takeover" || route === "source-restore-follow") {
      const skillId = values.get("skill-id"), fileId = values.get("file-id"), sourcePath = operands[1];
      if (!validSharedIdentity(skillId) || !validSharedIdentity(fileId) || !sourcePath || sourcePath.length > 4096 ||
          /[\\\u0000-\u001f\u007f-\u009f]/u.test(sourcePath) || /^[a-z]:/i.test(sourcePath) ||
          sourcePath.split("/").some(part => !part || part === "." || part === "..")) return undefined;
      if (route === "source-takeover") {
        const to = values.get("as") ?? "resource";
        if (to !== "native" && to !== "resource") return undefined;
        target = { route, sourceId: input, skillId, fileId, sourcePath, to };
      } else target = { route, sourceId: input, skillId, fileId, sourcePath };
    } else target = { route, sourceId: input };
  }
  if (values.get("dry-run") === "true") return undefined;
  if (predecessor !== undefined) return !validSharedIdentity(predecessor) || operationId === undefined ||
    operationId === predecessor || values.get("resume") === "true" ? undefined
    : { ...target, kind: "supersede", library, operationId, predecessor, sources };
  if (values.get("resume") === "true") return operationId === undefined ? undefined : { ...target, kind: "resume", library, operationId, sources };
  return { ...target, kind: "apply", library, operationId, sources };
}

function library(value: unknown): Library | undefined {
  if (!isObject(value) || !uuid(value.library_id)) return undefined;
  const databaseId = uuid(value.database_id), dataSourceId = uuid(value.data_source_id);
  return databaseId && dataSourceId ? { libraryId: uuid(value.library_id)!, databaseId, dataSourceId } : undefined;
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
  const configured = libraryId(source.library);
  if (known && configured && known.libraryId !== configured) return { kind: "invalid", source };
  return known ? { kind: "known", source, library: known, pages } : { kind: "unknown", source };
}

function operationMatches(call: OperationInvocation, value: Record<string, unknown>, failed = false): boolean {
  if (!validSharedIdentity(value.operation_id) || call.operationId !== undefined && value.operation_id !== call.operationId &&
      !(failed && call.kind === "supersede" && value.operation_id === call.predecessor)) return false;
  if (call.route === "import") return value.skill_id === call.skillId;
  return sourceIdentity(value.source_id) && (call.route === "source-apply" || value.source_id === call.sourceId);
}

function currentSkillWrite(result: Record<string, unknown>): CurrentSkillWrite | undefined {
  if (result.contract !== "current" || result.state !== "ready" || result.dry_run === true ||
      result.status !== "applied" && result.status !== "unchanged" || !validSharedIdentity(result.skill_id) ||
      !validSharedIdentity(result.operation_id) || !hash(result.input_sha256) ||
      typeof result.files !== "number" || !Number.isSafeInteger(result.files) || result.files < 1) return undefined;
  const owner = library(result.library), pageId = uuid(result.page_id);
  return owner && pageId ? { library: owner, skillId: result.skill_id, pageId, status: result.status } : undefined;
}

function currentSourceWrite(call: Exclude<OperationInvocation, { route: "import" }>, result: Record<string, unknown>): CurrentWrite | undefined {
  if (result.version !== 1 || result.contract !== "current" || result.dry_run === true || !sourceIdentity(result.source_id) ||
      !hash(result.input_sha256) || !hash(result.configuration_sha256) || !hash(result.revision) ||
      !Array.isArray(result.affected_skill_ids) || !Array.isArray(result.targets)) return undefined;
  const owner = library(result.library), sourcePage = uuid(result.source_page_id), sourceTable = uuid(result.sources_data_source_id);
  if (!owner || !sourcePage || !sourceTable || sourceTable === owner.dataSourceId) return undefined;
  switch (call.route) {
    case "source-apply":
    case "source-refresh":
      if (result.action !== "declaration" || typeof result.resolved_commit !== "string" || !/^[a-f\d]{40}$/.test(result.resolved_commit)) return undefined;
      break;
    case "source-enable":
    case "source-disable":
      if (result.action !== "enabled" || result.enabled !== (call.route === "source-enable")) return undefined;
      break;
    case "source-remove":
      if (result.action !== "remove") return undefined;
      break;
    case "source-takeover":
    case "source-restore-follow":
      if (result.action !== (call.route === "source-takeover" ? "takeover" : "restore_follow") ||
          result.file_id !== call.fileId || result.source_path !== call.sourcePath ||
          result.affected_skill_ids.length !== 1 || result.affected_skill_ids[0] !== call.skillId) return undefined;
      break;
  }
  if (call.route === "source-remove") {
    if (result.state !== "removed" || result.status !== "removed") return undefined;
  } else if (result.state !== "ready" || result.status !== "applied" && result.status !== "unchanged") return undefined;
  const metadataTargets = call.route === "source-enable" || call.route === "source-disable" || call.route === "source-remove";
  const affected = new Set<string>(), pages = new Map<string, string>(), physicalPages = new Set<string>();
  for (const id of result.affected_skill_ids) {
    if (!validSharedIdentity(id) || affected.has(id)) return undefined;
    affected.add(id);
  }
  for (const raw of result.targets) {
    if (!isObject(raw)) return undefined;
    let skillId: string, pageId: string;
    if (metadataTargets) {
      const physical = uuid(raw.skill_page_id);
      if (!validSharedIdentity(raw.skill_id) || !physical ||
          Object.keys(raw).some(key => key !== "skill_id" && key !== "skill_page_id")) return undefined;
      skillId = raw.skill_id; pageId = physical;
    } else {
      if (raw.state === "removed") {
        const physical = uuid(raw.page_id), targetLibrary = library(raw.library);
        if (call.route !== "source-apply" && call.route !== "source-refresh" ||
            result.status !== "applied" || raw.contract !== "current" || raw.status !== "removed" ||
            raw.files !== 0 || !validSharedIdentity(raw.skill_id) || !physical ||
            !validSharedIdentity(raw.operation_id) || !hash(raw.input_sha256) ||
            !targetLibrary || !sameLibrary(owner, targetLibrary)) return undefined;
        skillId = raw.skill_id; pageId = physical;
      } else {
        const target = currentSkillWrite(raw);
        if (!target || !sameLibrary(owner, target.library) || result.status === "unchanged" && target.status !== "unchanged") return undefined;
        skillId = target.skillId; pageId = target.pageId;
      }
    }
    if (!affected.has(skillId) || pages.has(skillId) || physicalPages.has(pageId) || pageId === sourcePage) return undefined;
    pages.set(skillId, pageId); physicalPages.add(pageId);
  }
  return pages.size === affected.size ? { library: owner, pages, status: result.status } : undefined;
}

function nativeTargetMatches(call: NativeSkillInvocation, value: Record<string, unknown>, pageField: "page_id" | "skill_page_id"): boolean {
  if (!validSharedIdentity(value.skill_id)) return false;
  if (call.action === "register" && call.skillId !== undefined && call.skillId !== value.skill_id) return false;
  return call.target.kind === "skill" ? value.skill_id === call.target.skillId : uuid(value[pageField]) === call.target.pageId;
}

function removalCoordinates(result: Record<string, unknown>, ownerPage: string): boolean {
  if (!Array.isArray(result.files) || result.files.length > 10000 || !Array.isArray(result.resources) || result.resources.length > 10000
      || !Array.isArray(result.relations) || result.relations.length > 20000) return false;
  const pages = new Set([ownerPage]), files = new Set<string>(), paths = new Set<string>(), resources = new Set<string>();
  for (const file of result.files) {
    if (!isObject(file) || !validSharedIdentity(file.file_id) || !skillPath(file.path) || !hash(file.content_sha256)) return false;
    const page = uuid(file.page_id);
    if (!page || pages.has(page) || files.has(file.file_id) || paths.has(file.path)) return false;
    pages.add(page); files.add(file.file_id); paths.add(file.path);
  }
  for (const resource of result.resources) {
    if (!isObject(resource) || typeof resource.resource_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(resource.resource_id)
        || !hash(resource.payload_sha256)) return false;
    const page = uuid(resource.page_id);
    if (!page || pages.has(page) || resources.has(resource.resource_id)) return false;
    pages.add(page); resources.add(resource.resource_id);
  }
  const relationKeys = new Set<string>();
  for (const relation of result.relations) {
    if (!isObject(relation) || !validSharedIdentity(relation.skill_id) || relation.field !== "Members" && relation.field !== "Requires"
        || !Array.isArray(relation.before) || relation.before.length > 10000 || !Array.isArray(relation.after) || relation.after.length > 100) return false;
    const page = uuid(relation.page_id), before = relation.before.map(uuid), after = relation.after.map(uuid);
    if (!page || page === ownerPage || before.includes(undefined) || after.includes(undefined)
        || new Set(before).size !== before.length || new Set(after).size !== after.length || !before.includes(ownerPage)
        || after.length !== before.length - 1 || after.some(value => value === ownerPage || !before.includes(value))) return false;
    const key = page + ":" + relation.field;
    if (relationKeys.has(key)) return false;
    relationKeys.add(key);
  }
  return true;
}

function nativeSkillWrite(call: NativeSkillInvocation, result: Record<string, unknown>): CurrentWrite | undefined {
  if (result.ok !== true || result.contract !== "current" || result.action !== call.action || result.dry_run === true
      || !validSharedIdentity(result.operation_id) || !hash(result.input_sha256) || !nativeTargetMatches(call, result, "page_id")) return undefined;
  const owner = library(result.library), page = uuid(result.page_id);
  if (!owner || !page || !validSharedIdentity(result.skill_id)) return undefined;
  if (call.action === "remove") {
    if (result.version !== 1 || result.state !== "removed" || result.status !== "removed" || result.cleanup_verified !== true
        || !removalCoordinates(result, page)) return undefined;
  } else {
    if (result.state !== "ready" || typeof result.files !== "number" || !Number.isSafeInteger(result.files) || result.files < 1) return undefined;
    switch (call.action) {
      case "create": if (result.status !== "created") return undefined; break;
      case "update": if (result.status !== "applied") return undefined; break;
      case "register":
        if (result.version !== 1 || result.status !== "registered" || !Array.isArray(result.paths)
            || result.paths.length !== result.files || result.paths.some(path => !skillPath(path)) || new Set(result.paths).size !== result.paths.length) return undefined;
        break;
      default: { const exhaustive: never = call; return exhaustive; }
    }
  }
  return { library: owner, pages: new Map([[result.skill_id, page]]), status: call.action === "remove" ? "removed" : "applied" };
}

function currentWrite(call: Invocation, result: Record<string, unknown>): CurrentWrite | undefined {
  if (call.route === "skill") return nativeSkillWrite(call, result);
  if (result.ok !== true || !operationMatches(call, result)) return undefined;
  if (call.route !== "import") return currentSourceWrite(call, result);
  const target = currentSkillWrite(result);
  return target ? { library: target.library, pages: new Map([[target.skillId, target.pageId]]), status: target.status } : undefined;
}

function successfulSources(call: Invocation, result: CurrentWrite, bindings: SourceBinding[]): string[] {
  const selected = libraryId(call.library);
  if (!selected || selected !== result.library.libraryId) return [];
  return bindings.filter(binding => binding.kind !== "invalid"
    && (binding.kind === "known" ? sameLibrary(binding.library, result.library) : libraryId(binding.source.library) === selected))
    .map(binding => binding.source.id);
}

/** An unknown write requires only a scoped reread; it never proves completion. */
function librarySources(call: Invocation, bindings: SourceBinding[]): string[] {
  const selected = libraryId(call.library);
  if (!selected) return [];
  return bindings.filter(binding => binding.kind !== "invalid" &&
    (libraryId(binding.source.library) === selected || binding.kind === "known" && binding.library.libraryId === selected))
    .map(binding => binding.source.id);
}

function affectedSources(call: Invocation, output: CliOutput, records: SkillRecord[]): string[] {
  if (output.status === "invalid") return [];
  const bindings = call.sources.map(source => sourceBinding(source, records));
  if (output.status === "truncated") return librarySources(call, bindings);
  const result = output.result;
  if (result.ok === false) {
    const error = result.error;
    if (!isObject(error) || !isObject(error.details)) return [];
    if (call.route === "skill") {
      const details = error.details;
      if (!isObject(details.owner) || details.owner.kind !== "skill" || details.owner.id !== details.skill_id
          || !validSharedIdentity(details.operation_id) || !hash(details.input_sha256) || details.next !== "reconcile_current"
          || !nativeTargetMatches(call, details, "skill_page_id")) return [];
      return librarySources(call, bindings);
    }
    if (!operationMatches(call, error.details, true)) return [];
    if (call.route !== "import") {
      const details = error.details;
      if (!isObject(details.owner) || details.owner.kind !== "source" || details.owner.id !== details.source_id ||
          !hash(details.input_sha256) || details.next !== "reconcile_current") return [];
    }
    return librarySources(call, bindings);
  }
  const written = currentWrite(call, result);
  return written && (written.status !== "unchanged" || call.kind !== "apply") ? successfulSources(call, written, bindings) : [];
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
  sources: SourceConfig[] | (() => SourceConfig[]);
  records(): SkillRecord[];
  changed(sourceIds: string[], ctx: ExtensionContext): void;
}): void {
  const sources = () => (typeof options.sources === "function" ? options.sources() : options.sources).filter((source): source is NotionSource => source.type === "notion" && source.enabled !== false);
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
    const call = invocation(event.input.command, sources());
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
