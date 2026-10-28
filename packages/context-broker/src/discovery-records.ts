import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RouterDiscoveryRecord, ConfigFile, DiscoveryMember, DiscoveryRecord, ScanConfig, SkillRecord, RawCatalogMember, CatalogRemoteReference, CatalogResolutionContext } from "./types";
import { normalizeKey, skillRecordFromFile, uniqueStrings } from "./skill-records";
import { isBundledBuiltin, isBundledBuiltinToken } from "./bundled-builtins";

export function recordKind(record: DiscoveryRecord): "skill" | "router" | "prompt" {
  return record.kind ?? "skill";
}

export function recordName(record: DiscoveryRecord): string {
  return record.name;
}

export function recordToken(record: DiscoveryRecord): string {
  return record.selectionToken ?? record.token ?? record.alias ?? normalizeKey(record.name);
}

function encodeSelectionId(id: string): string {
  return encodeURIComponent(id).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
}
function preciseSelector(record: DiscoveryRecord): string {
  return record.locator?.type === "notion_page" ? record.locator.page_id.replaceAll("-", "")
    : record.locator?.type === "notion_subscription" ? record.locator.subscription_id.replaceAll("-", "")
    : encodeSelectionId(record.id ?? "local:" + resolve(record.path));
}
function recordNamespace(record: DiscoveryRecord): string {
  return record.sourceId ? record.token?.split("/")[0] ?? record.sourceId : "local";
}

/** The same identity-qualified syntax already used for colliding catalog entries. */
export function preciseRecordToken(record: DiscoveryRecord): string {
  if (isBundledBuiltin(record)) return recordToken(record);
  return `${record.alias ?? recordNormalizedName(record)}@${preciseSelector(record)}@${recordNamespace(record)}`;
}
function parsePreciseSelection(query: string): { selector: string; namespace: string } | undefined {
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(query)) return undefined;
  const parts = query.split("@");
  if (parts.length !== 3 || !parts[0] || /[\s/]/u.test(parts[0]) || !/^[\p{L}\p{N}._-]+$/u.test(parts[2]!)) return undefined;
  const selector = parts[1]!;
  if (/^[0-9a-f]{32}$/i.test(selector)) return { selector: selector.toLowerCase(), namespace: parts[2]! };
  try {
    const id = decodeURIComponent(selector);
    if (id.startsWith("local:") && isAbsolute(id.slice(6)) && encodeSelectionId(id) === selector) return { selector, namespace: parts[2]! };
  } catch { /* Malformed text is not an identity-qualified reference. */ }
  return undefined;
}
export function isPreciseSelectionToken(query: string): boolean {
  return isBundledBuiltinToken(query) || parsePreciseSelection(query) !== undefined;
}
export function matchesPreciseRecordToken(query: string, record: DiscoveryRecord): boolean {
  const selection = parsePreciseSelection(query);
  return Boolean(selection && !isBundledBuiltin(record) && selection.selector === preciseSelector(record) && selection.namespace === recordNamespace(record));
}

export function recordIdentity(record: DiscoveryRecord): string {
  const locator = record.locator ?? { type: "local", id: resolve(record.path), entry: record.path };
  return JSON.stringify([record.sourceId ?? "local", record.sourceScope ?? "", recordKind(record), locator.type, record.id ?? "local:" + (locator.type === "local" ? locator.id : record.path)]);
}

export function recordAliases(record: DiscoveryRecord): string[] {
  return record.aliases ?? [];
}

export function recordDescription(record: DiscoveryRecord): string {
  return record.description ?? "";
}

export function recordPath(record: DiscoveryRecord): string {
  return recordKind(record) === "router" ? (record as RouterDiscoveryRecord).path : (record as SkillRecord).path;
}

export function recordNormalizedName(record: DiscoveryRecord): string {
  return record.alias ?? (record.normalizedName || normalizeKey(record.name));
}

export function recordNormalizedAliases(record: DiscoveryRecord): string[] {
  return record.normalizedAliases?.length ? record.normalizedAliases : recordAliases(record).map(normalizeKey).filter(Boolean);
}

export function recordNormalizedDescription(record: DiscoveryRecord): string {
  return record.normalizedDescription || normalizeKey(recordDescription(record));
}

export function skillDiscoveryRecord(skill: SkillRecord): SkillRecord & { kind: "skill" } {
  return { ...skill, kind: "skill" };
}

export function normalizeDiscoveryRecord(record: DiscoveryRecord): DiscoveryRecord {
  if (recordKind(record) !== "router" || !record.members) return { ...record, kind: recordKind(record) };
  const router = record as RouterDiscoveryRecord;
  return {
    ...router,
    kind: "router",
    aliases: uniqueStrings(router.aliases ?? []),
    normalizedName: router.source === "notion" ? router.alias! : normalizeKey(router.name),
    normalizedAliases: uniqueStrings((router.aliases ?? []).map(normalizeKey).filter(Boolean)),
    normalizedDescription: normalizeKey(router.description),
    members: router.members.map((member) => ({
      ...member,
      aliases: uniqueStrings(member.aliases ?? []),
    })),
  };
}

export function dedupeDiscoveryRecords<T extends DiscoveryRecord>(records: T[]): T[] {
  const indexes = new Map<string, number>();
  const result: T[] = [];
  for (const record of records) {
    const key = recordKind(record) === "skill" && !record.sourceId && !isBundledBuiltin(record)
      ? JSON.stringify(["local-skill", recordNormalizedName(record)])
      : recordIdentity(record);
    const existingIndex = indexes.get(key);
    if (existingIndex !== undefined) {
      continue;
    }
    indexes.set(key, result.length);
    result.push(record);
  }
  const byName = new Map<string, DiscoveryRecord[]>();
  for (const record of result) {
    const name = recordNormalizedName(record);
    const group = byName.get(name);
    if (group) group.push(record);
    else byName.set(name, [record]);
  }
  const conflicted = new Set<DiscoveryRecord>();
  for (const source of result) {
    
    const keys = [recordNormalizedName(source), ...recordNormalizedAliases(source), recordNormalizedDescription(source)];
    for (const key of keys) {
      if (!key) continue;
      for (const other of byName.get(key) ?? []) {
        if (other === source) continue;
        conflicted.add(source);
        conflicted.add(other);
      }
    }
  }
  const selectors = new Map<DiscoveryRecord, string>();
  const counts = new Map<string, number>();
  for (const record of conflicted) {
    const skill = record as SkillRecord;
    const origin = isBundledBuiltin(skill) ? "builtin" : skill.sourceId ? skill.token?.split("/")[0] ?? skill.sourceId : "local";
    const selector = `${record.alias ?? normalizeKey(record.name)}@${origin}`;
    selectors.set(record, selector);
    const key = selector;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return result.map((record) => {
    const skill = record as SkillRecord;
    const stableSelection = skill.source === "notion" || isBundledBuiltin(skill) ? record.selectionToken : undefined;
    let selectionToken = stableSelection ?? selectors.get(record);
    if (!isBundledBuiltin(skill) && selectionToken && counts.get(selectionToken)! > 1) {
      selectionToken = preciseRecordToken(record);
    }
    return selectionToken === record.selectionToken ? record : { ...record, selectionToken };
  });
}

export class InvocationError extends Error {
  readonly code: string;
  constructor(query: string, reason: string, candidates: DiscoveryRecord[] = []) {
    const tokens = candidates.map((record) => recordToken(record));
    const hint = tokens.length === 0 ? "" : new Set(tokens).size === tokens.length
      ? `; choose ${tokens.map((token) => `$${token}`).join(", ")}`
      : `; run /context-broker find ${query.split("@")[0]!.split("/")[0]!}`;
    super(`context-broker: $${query}: ${reason}${hint}`);
    this.name = "InvocationError";
    this.code = reason === "ambiguous" ? "INVOCATION_AMBIGUOUS" : "INVOCATION_NOT_FOUND";
  }
}

export function validateDiscoveryRecords(records: DiscoveryRecord[]): string[] {
  const errors: string[] = [];
  const byName = new Map<string, DiscoveryRecord>();
  const byAlias = new Map<string, DiscoveryRecord>();
  for (const record of records) {
    const name = normalizeKey(recordToken(record));
    if (!name) {
      errors.push(`record has empty name: ${recordKind(record)}`);
      continue;
    }
    const existing = byName.get(name);
    if (existing) {
      const kinds = new Set([recordKind(existing), recordKind(record)]);
      {
        errors.push(`name collision: ${recordKind(existing)} "${recordName(existing)}" conflicts with ${recordKind(record)} "${recordName(record)}"`);
      }

    } else {
      byName.set(name, record);
    }
  }
  for (const record of records) {
    for (const alias of recordNormalizedAliases(record)) {
      const nameOwner = byName.get(alias);
      if (nameOwner) {
        errors.push(`alias collision: alias "${alias}" on ${recordKind(record)} "${recordName(record)}" conflicts with ${recordKind(nameOwner)} name "${recordName(nameOwner)}"`);
      }
      const aliasOwner = byAlias.get(alias);
      if (aliasOwner) {
        errors.push(`alias collision: alias "${alias}" used by ${recordKind(aliasOwner)} "${recordName(aliasOwner)}" and ${recordKind(record)} "${recordName(record)}"`);
      } else {
        byAlias.set(alias, record);
      }
    }
    if (recordKind(record) === "router" && record.members) {
      const router = record as RouterDiscoveryRecord;
      if (router.members.length === 0) errors.push(`router "${router.name}" has no members`);
      for (const member of router.members) {
        if (!member.name.trim()) errors.push(`router "${router.name}" has member with empty name`);
        if (!(member.description ?? "").trim()) errors.push(`router "${router.name}" member "${member.name}" has empty description`);
        if (member.unavailable) {
          errors.push(`router "${router.name}" member "${member.name}" unavailable (${member.unavailable.code}): ${member.unavailable.message}`);
        } else if (member.type === "local" && !member.path.trim()) errors.push(`router "${router.name}" member "${member.name}" has empty path`);
        else if (member.type === "local" && !existsSync(member.path)) errors.push(`router "${router.name}" member "${member.name}" path missing: ${member.path}`);
      }
    }
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean));
}

function resolveCatalogPath(path: string, catalogDir: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(catalogDir, path);
}

function readCatalogFile(path: string): unknown {
  const content = readFileSync(path, "utf8");
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return parseYaml(content);
  return JSON.parse(content);
}

function memberFromSkill(skill: SkillRecord): DiscoveryMember {
  return {
    type: "local",
    id: skill.id,
    kind: "skill",
    ref: skill.ref ?? skill.path,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    aliases: skill.aliases,
  };
}

function skillLookupKeys(skill: SkillRecord): string[] {
  return [skill.normalizedName, normalizeKey(basename(dirname(skill.path))), ...skill.normalizedAliases].filter(Boolean);
}

function buildSkillLookup(skills: SkillRecord[]): Map<string, SkillRecord[]> {
  const lookup = new Map<string, SkillRecord[]>();
  for (const skill of skills) {
    for (const key of skillLookupKeys(skill)) {
      const group = lookup.get(key) ?? [];
      if (!group.some(previous => recordIdentity(previous) === recordIdentity(skill))) group.push(skill);
      lookup.set(key, group);
    }
  }
  return lookup;
}

function includePatternHasGlob(value: string): boolean {
  return value.includes("*");
}

function includePatternMatches(pattern: string, skill: SkillRecord): boolean {
  const normalizedPattern = normalizeKey(pattern);
  return skillLookupKeys(skill).some((key) => globKeyMatches(normalizedPattern, key));
}

function globKeyMatches(pattern: string, value: string): boolean {
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`).test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function membersFromInclude(include: string[], skillLookup: Map<string, SkillRecord[]>, skills: SkillRecord[], recordName: string): DiscoveryMember[] {
  const members: SkillRecord[] = [];
  const seen = new Set<string>();
  for (const memberName of include) {
    const matched = includePatternHasGlob(memberName)
      ? skills.filter((skill) => includePatternMatches(memberName, skill)).sort((left, right) => left.name.localeCompare(right.name))
      : skillLookup.get(normalizeKey(memberName)) ?? [];
    if (!includePatternHasGlob(memberName) && matched.length > 1) throw new Error(`Ambiguous Router member: ${memberName}; select an exact member path`);
    if (matched.length === 0) throw new Error(`context-broker catalog router "${recordName}" includes unknown skill: ${memberName}`);
    for (const skill of matched) {
      if (seen.has(recordIdentity(skill))) continue;
      seen.add(recordIdentity(skill));
      members.push(skill);
    }
  }
  return members.sort((a, b) => recordIdentity(a).localeCompare(recordIdentity(b))).map(memberFromSkill);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("Unknown catalog member field");
}

/** Catalogs declare identities; only the current configured source catalog grants candidates. */
export function parseCatalogMember(value: unknown): RawCatalogMember {
  if (!isRecord(value)) throw new Error("Invalid Router member");
  if (value.type === "local") {
    exactKeys(value, ["type", "path", "name", "description", "aliases"]);
    if (typeof value.path !== "string" || !value.path.trim()) throw new Error("Router members require an exact Skill entry path");
    if ([value.name, value.description].some(item => item !== undefined && typeof item !== "string") || value.aliases !== undefined && (!Array.isArray(value.aliases) || !value.aliases.every(item => typeof item === "string"))) throw new Error("Invalid local Router member metadata");
    return value as RawCatalogMember;
  }
  if (value.type !== "remote") throw new Error("Router member type must be local or remote");
  exactKeys(value, ["type", "source", "id", "locator", "ref"]);
  if (!isRecord(value.source) || typeof value.source.namespace !== "string" || !/^[\p{L}\p{N}._-]+$/u.test(value.source.namespace)) throw new Error("Remote member requires configured source namespace");
  exactKeys(value.source, ["namespace"]);
  if (!isRecord(value.locator)) throw new Error("Remote member requires stable locator");
  const locator = value.locator;
  const subscription = locator.type === "notion_subscription";
  if (locator.type !== "notion_page" && !subscription) throw new Error("Invalid remote member locator");
  const keys = subscription ? ["type", "subscription_id", "database_id", "data_source_id", "target_database_id"] : ["type", "page_id", "database_id", "data_source_id"];
  exactKeys(locator, keys);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (keys.filter(key => key !== "type").some(key => typeof locator[key] !== "string" || !uuid.test(locator[key] as string))) throw new Error("Invalid remote member stable identity");
  const id = subscription ? locator.subscription_id : locator.page_id;
  const selector = subscription ? `upstream:${id}` : id;
  const prefix = `skill://${encodeURIComponent(selector as string)}/`;
  if (value.id !== `${locator.type}:${id}` || typeof value.ref !== "string" || !value.ref.startsWith(prefix) || !/^(SKILL|ROUTER|PROMPT)\.md(?:\?snapshot=s_[0-9a-f]{64})?$/.test(value.ref.slice(prefix.length))) throw new Error("Remote member ref/identity mismatch");
  return value as CatalogRemoteReference;
}

export function resolveCatalogReference(reference: CatalogRemoteReference, context: CatalogResolutionContext, kind: "skill" | "router"): SkillRecord {
  const sources = (context.sources ?? []).filter(source => source.enabled !== false && source.type === "notion" && (source.namespace ?? source.id) === reference.source.namespace);
  const observedCandidates = (context.records ?? []).filter(record => record.source === "notion" && sources.some(source => source.id === record.sourceId) && record.id === reference.id);
  const candidates = observedCandidates.filter(record => record.locator && Object.entries(reference.locator).every(([key, value]) => record.locator![key as keyof typeof record.locator] === value) && Object.keys(record.locator).length === Object.keys(reference.locator).length);
  const candidateLabels = observedCandidates.map(record => `${record.sourceId}:${record.id}:${JSON.stringify(record.locator)}`);
  const fail = (code: string, message: string): never => { throw new CatalogReferenceError(code, message, candidateLabels); };
  if (!sources.length) fail("SOURCE_UNAVAILABLE", `No enabled configured Notion source for namespace ${reference.source.namespace}`);
  const failures = (context.failures ?? []).filter(failure => sources.some(source => source.id === failure.sourceId));
  if (failures.length) fail(failures[0]!.code, `Source unavailable: ${failures.map(failure => `${failure.sourceId} (${failure.code})`).join(", ")}`);
  if (candidates.length > 1) fail("CATALOG_MEMBER_AMBIGUOUS", `Multiple current source records: ${candidateLabels.join(", ")}`);
  const record = candidates[0];
  if (!record) fail(observedCandidates.length ? "SOURCE_IDENTITY_MISMATCH" : "CATALOG_MEMBER_UNAVAILABLE", `Record ${reference.id} with the declared locator absent from current credential-scoped catalog for ${reference.source.namespace}`);
  const observed = record!;
  const locator = observed.locator;
  if (!observed.sourceScope || !/^[0-9a-f]{64}$/.test(observed.sourceScope) || !locator || observed.kind !== kind || observed.ref !== reference.ref.split("?")[0]) fail("SOURCE_IDENTITY_MISMATCH", `Reference does not match current ${kind} record ${reference.id}`);
  return observed;
}

export class CatalogReferenceError extends Error {
  constructor(readonly code: string, message: string, readonly candidates: string[] = []) { super(message); this.name = "CatalogReferenceError"; }
}

function unavailableLocalMember(path: string, raw: Extract<RawCatalogMember, { type: "local" }>, scan: ScanConfig): DiscoveryMember | undefined {
  let code: string;
  let message: string;
  try {
    const size = statSync(path).size;
    const maxBytes = scan.maxSkillBytes ?? 64 * 1024;
    if (maxBytes <= 0 || size <= maxBytes) return undefined;
    code = "LOCAL_ENTRY_TOO_LARGE";
    message = `scan_size_limit: Declared local Skill entry exceeds scan limit: ${path} (${size} bytes; maxSkillBytes=${maxBytes})`;
  } catch (error) {
    const missingCode = (error as NodeJS.ErrnoException).code;
    if (missingCode !== "ENOENT" && missingCode !== "ENOTDIR") throw error;
    code = missingCode;
    message = `Declared local Skill entry unavailable (${code}): ${path}`;
  }
  return { type: "local", kind: "skill", id: `local:${path}`, ref: path, path, name: raw.name?.trim() || basename(dirname(path)), description: raw.description?.trim() || message, aliases: uniqueStrings(raw.aliases ?? []), unavailable: { code, message, candidates: [] } };
}

function memberFromRaw(value: unknown, catalogDir: string, scan: ScanConfig, context: CatalogResolutionContext): DiscoveryMember {
  const raw = parseCatalogMember(value);
  if (raw.type === "remote") {
    try {
      const record = resolveCatalogReference(raw, context, "skill");
      return { type: "remote", source: raw.source, sourceId: record.sourceId, sourceScope: record.sourceScope, id: record.id, locator: raw.locator, kind: "skill", ref: raw.ref, name: record.name, description: record.description, aliases: record.aliases };
    } catch (error) {
      if (!(error instanceof CatalogReferenceError)) throw error;
      return { ...raw, kind: "skill", name: raw.id, description: `Unavailable: ${error.message}`, unavailable: { code: error.code, message: error.message, candidates: error.candidates } };
    }
  }
  const path = resolveCatalogPath(raw.path, catalogDir);
  if (basename(path) !== "SKILL.md") throw new Error("Router members require an exact Skill entry path");
  const missing = unavailableLocalMember(path, raw, scan);
  if (missing) return missing;
  const parsed = skillRecordFromFile(path, false, undefined, scan);
  if (!parsed) {
    const missing = unavailableLocalMember(path, raw, scan);
    if (missing) return missing;
    throw new Error(`Router member unavailable: ${path}`);
  }
  return { ...memberFromSkill(parsed), name: raw.name?.trim() || parsed.name, description: raw.description?.trim() || parsed.description, aliases: uniqueStrings([...parsed.aliases, ...(raw.aliases ?? [])]) };
}

function routerFromRaw(name: string | undefined, value: unknown, catalogPath: string, skills: SkillRecord[] = [], skillLookup = buildSkillLookup(skills), scan: ScanConfig = {}, context: CatalogResolutionContext = {}): DiscoveryRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "remote") {
    const { kind, ...reference } = value;
    if (kind !== undefined && kind !== "router") throw new Error("Remote catalog record kind must be router");
    const parsed = parseCatalogMember(reference);
    if (parsed.type !== "remote") throw new Error("Remote catalog Router requires remote reference");
    const record = resolveCatalogReference(parsed, context, "router");
    if (parsed.ref !== record.ref) throw new CatalogReferenceError("SOURCE_IDENTITY_MISMATCH", "Direct remote Router catalog records require the canonical unpinned entry ref");
    return record;
  }
  const catalogDir = dirname(catalogPath);
  const recordName = typeof value.name === "string" && value.name.trim() ? value.name : name;
  if (!recordName || !normalizeKey(recordName)) return undefined;
  let members: DiscoveryMember[] = [];
  if (Array.isArray(value.members)) {
    members = value.members.map((member) => memberFromRaw(member, catalogDir, scan, context));
    const identity = (member: DiscoveryMember) => member.type === "remote"
      ? JSON.stringify([member.sourceId ?? member.source.namespace, member.sourceScope ?? "", member.id, member.locator])
      : member.id ?? member.path;
    members = [...new Map(members.map(member => [identity(member), member])).values()].sort((a, b) => identity(a).localeCompare(identity(b)));
  } else if (isRecord(value.members) && Array.isArray(value.members.include)) {
    members = membersFromInclude(stringArray(value.members.include), skillLookup, skills, recordName);
  } else if ("members" in value) {
    throw new Error(`context-broker catalog router "${recordName}" members must be an array or { include: string[] }`);
  }
  return normalizeDiscoveryRecord({
    kind: "router",
    id: `local:${catalogPath}#${recordName}`,
    locator: { type: "local", id: `${catalogPath}#${recordName}`, entry: catalogPath },
    source: "local",
    autoloadEnabled: true,
    entrypoint: "ROUTER.md",
    ref: `local:${catalogPath}#${recordName}`,
    name: recordName,
    description: typeof value.description === "string" ? value.description.trim() : "",
    aliases: stringArray(value.aliases),
    path: catalogPath,
    normalizedName: "",
    normalizedAliases: [],
    normalizedDescription: "",
    render: isRecord(value.render) ? value.render as RouterDiscoveryRecord["render"] : { type: "member-index" },
    policy: isRecord(value.policy) ? value.policy as RouterDiscoveryRecord["policy"] : undefined,
    members,
  }) as RouterDiscoveryRecord;
}

export function readDiscoveryCatalog(path: string, skills: SkillRecord[] = [], scan: ScanConfig = {}, context: CatalogResolutionContext = {}): DiscoveryRecord[] {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) return [];
  const raw = readCatalogFile(absolutePath);
  if (!isRecord(raw)) return [];
  if ("bundles" in raw || Array.isArray(raw.records) && raw.records.some(record => isRecord(record) && record.kind === "bundle")) throw new Error("Historical Bundle catalog requires scripts/migrate-content-assets.mjs");
  const records: DiscoveryRecord[] = [];
  const skillLookup = buildSkillLookup(skills);
  const rawRecords = Array.isArray(raw.records) ? raw.records : [];
  for (const rawRecord of rawRecords) {
    if (!isRecord(rawRecord)) throw new Error("Invalid Router catalog record");
    if (rawRecord.kind !== "router") throw new Error("Catalog kind must be router");
    if (rawRecord.kind === "router") {
      const router = routerFromRaw(undefined, rawRecord, absolutePath, skills, skillLookup, scan, context);
      if (router) records.push(router);
    }
  }
  if (isRecord(raw.routers)) {
    for (const [name, value] of Object.entries(raw.routers)) {
      const router = routerFromRaw(name, value, absolutePath, skills, skillLookup, scan, context);
      if (router) records.push(router);
    }
  }
  return records;
}

export function configuredDiscoveryCatalogs(config: ConfigFile, cwd = process.cwd()): string[] {
  const env = process.env.CONTEXT_BROKER_DISCOVERY_CATALOGS;
  const envExtra = process.env.CONTEXT_BROKER_EXTRA_DISCOVERY_CATALOGS;
  const paths = [
    ...(env ? env.split(delimiter).map((part) => part.trim()).filter(Boolean) : config.discoveryCatalogs ?? []),
    ...(config.extraDiscoveryCatalogs ?? []),
    ...(envExtra ? envExtra.split(delimiter).map((part) => part.trim()).filter(Boolean) : []),
  ];
  return uniqueStrings(paths.map((path) => resolveCatalogPath(path, cwd)));
}

export async function buildDiscoveryRegistryFromParts(skills: SkillRecord[], catalogs: string[], scan: ScanConfig = {}, context: CatalogResolutionContext = {}): Promise<DiscoveryRecord[]> {
  return [
    ...skills.map(skillDiscoveryRecord),
    ...catalogs.flatMap((catalog) => readDiscoveryCatalog(catalog, skills, scan, context)),
  ].map(normalizeDiscoveryRecord);
}
