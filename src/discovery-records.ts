import { existsSync, readFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BundleDiscoveryRecord, BundleRouting, ConfigFile, DiscoveryMember, DiscoveryRecord, ScanConfig, SkillRecord } from "./types";
import { dedupeRegistryByNormalizedName, normalizeKey, skillRecordFromFile, uniqueStrings } from "./skill-records";

export function recordKind(record: DiscoveryRecord): "skill" | "bundle" {
  return "kind" in record && record.kind === "bundle" ? "bundle" : "skill";
}

export function recordName(record: DiscoveryRecord): string {
  return record.name;
}

export function recordAliases(record: DiscoveryRecord): string[] {
  return record.aliases ?? [];
}

export function recordDescription(record: DiscoveryRecord): string {
  return record.description ?? "";
}

export function recordPath(record: DiscoveryRecord): string {
  return recordKind(record) === "bundle" ? (record as BundleDiscoveryRecord).path : (record as SkillRecord).path;
}

export function recordNormalizedName(record: DiscoveryRecord): string {
  return record.normalizedName || normalizeKey(record.name);
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
  if (recordKind(record) === "skill") return skillDiscoveryRecord(record as SkillRecord);
  const bundle = record as BundleDiscoveryRecord;
  return {
    ...bundle,
    kind: "bundle",
    aliases: uniqueStrings(bundle.aliases ?? []),
    normalizedName: normalizeKey(bundle.name),
    normalizedAliases: uniqueStrings((bundle.aliases ?? []).map(normalizeKey).filter(Boolean)),
    normalizedDescription: normalizeKey(bundle.description),
    members: bundle.members.map((member) => ({
      ...member,
      aliases: uniqueStrings(member.aliases ?? []),
    })),
  };
}

export function dedupeDiscoveryRecordsByNormalizedName(records: DiscoveryRecord[]): DiscoveryRecord[] {
  const indexes = new Map<string, number>();
  const result: DiscoveryRecord[] = [];
  for (const record of records) {
    const key = recordNormalizedName(record);
    const existingIndex = indexes.get(key);
    if (existingIndex !== undefined) {
      const existing = result[existingIndex];
      if (recordKind(existing) === "skill" && recordKind(record) === "bundle") {
        result[existingIndex] = record;
      }
      continue;
    }
    indexes.set(key, result.length);
    result.push(record);
  }
  return result;
}

function textLength(value: string): number {
  return [...value].length;
}

function comparableText(value: string): string {
  return value.replace(/\s+/g, "").toLocaleLowerCase();
}

function validateBundleRouting(bundle: BundleDiscoveryRecord): string[] {
  const routing = bundle.routing;
  if (!routing) return [];
  const errors: string[] = [];
  const limits = routing.limits ?? {};
  const memberByName = new Map(bundle.members.map((member) => [normalizeKey(member.name), member]));
  const groups = routing.groups ?? [];
  const groupIds = new Set<string>();

  if (!bundle.description.trim()) errors.push(`bundle "${bundle.name}" routing requires a non-empty description`);
  if (limits.descriptionChars && textLength(bundle.description) > limits.descriptionChars) {
    errors.push(`bundle "${bundle.name}" description exceeds ${limits.descriptionChars} characters`);
  }
  if (limits.overviewChars && routing.overview && textLength(routing.overview) > limits.overviewChars) {
    errors.push(`bundle "${bundle.name}" routing overview exceeds ${limits.overviewChars} characters`);
  }
  if (routing.overview && comparableText(routing.overview) === comparableText(bundle.description)) {
    errors.push(`bundle "${bundle.name}" routing overview must not duplicate description`);
  }

  for (const group of groups) {
    const id = normalizeKey(group.id);
    if (groupIds.has(id)) errors.push(`bundle "${bundle.name}" routing group duplicate: ${group.id}`);
    groupIds.add(id);
    if (limits.groupHintChars && group.hint && textLength(group.hint) > limits.groupHintChars) {
      errors.push(`bundle "${bundle.name}" routing group "${group.id}" hint exceeds ${limits.groupHintChars} characters`);
    }
  }

  const routedNames = new Set<string>();
  for (const [memberName, route] of Object.entries(routing.members ?? {})) {
    const normalizedName = normalizeKey(memberName);
    const member = memberByName.get(normalizedName);
    if (!member) {
      errors.push(`bundle "${bundle.name}" routing references unknown member: ${memberName}`);
      continue;
    }
    routedNames.add(normalizedName);
    if (route.group && !groupIds.has(normalizeKey(route.group))) {
      errors.push(`bundle "${bundle.name}" routing member "${memberName}" references unknown group: ${route.group}`);
    }
    if (limits.memberHintChars && textLength(route.hint) > limits.memberHintChars) {
      errors.push(`bundle "${bundle.name}" routing member "${memberName}" hint exceeds ${limits.memberHintChars} characters`);
    }
    if (comparableText(route.hint) === comparableText(member.description ?? "")) {
      errors.push(`bundle "${bundle.name}" routing member "${memberName}" hint must not duplicate description`);
    }
  }

  if (routing.requireHints) {
    for (const member of bundle.members) {
      if (!routedNames.has(normalizeKey(member.name))) {
        errors.push(`bundle "${bundle.name}" routing member "${member.name}" is missing required hint`);
      }
    }
  }
  return errors;
}

export function validateDiscoveryRecords(records: DiscoveryRecord[]): string[] {
  const errors: string[] = [];
  const byName = new Map<string, DiscoveryRecord>();
  const byAlias = new Map<string, DiscoveryRecord>();
  for (const record of records) {
    const name = recordNormalizedName(record);
    if (!name) {
      errors.push(`record has empty name: ${recordKind(record)}`);
      continue;
    }
    const existing = byName.get(name);
    if (existing) {
      const kinds = new Set([recordKind(existing), recordKind(record)]);
      if (!(kinds.has("skill") && kinds.has("bundle"))) {
        errors.push(`name collision: ${recordKind(existing)} "${recordName(existing)}" conflicts with ${recordKind(record)} "${recordName(record)}"`);
      }
      if (recordKind(record) === "bundle") byName.set(name, record);
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
    if (recordKind(record) === "bundle") {
      const bundle = record as BundleDiscoveryRecord;
      if (bundle.members.length === 0) errors.push(`bundle "${bundle.name}" has no members`);
      for (const member of bundle.members) {
        if (!member.name.trim()) errors.push(`bundle "${bundle.name}" has member with empty name`);
        if (!(member.description ?? "").trim()) errors.push(`bundle "${bundle.name}" member "${member.name}" has empty description`);
        if (!member.path.trim()) errors.push(`bundle "${bundle.name}" member "${member.name}" has empty path`);
        else if (!existsSync(member.path)) errors.push(`bundle "${bundle.name}" member "${member.name}" path missing: ${member.path}`);
      }
      errors.push(...validateBundleRouting(bundle));
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

function routingText(value: unknown, field: string, recordName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`context-broker catalog bundle "${recordName}" ${field} must be a non-empty string`);
  }
  return value.trim();
}

function routingStringArray(value: unknown, field: string, recordName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`context-broker catalog bundle "${recordName}" ${field} must be an array of non-empty strings`);
  }
  return uniqueStrings(value.map((item) => item.trim()));
}

function routingLimit(value: unknown, field: string, recordName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`context-broker catalog bundle "${recordName}" routing.limits.${field} must be a positive integer`);
  }
  return value;
}

function routingFromRaw(value: unknown, recordName: string): BundleRouting | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`context-broker catalog bundle "${recordName}" routing must be an object`);

  const overview = routingText(value.overview, "routing.overview", recordName);
  const rules = routingStringArray(value.rules, "routing.rules", recordName);
  const combinations = routingStringArray(value.combinations, "routing.combinations", recordName);
  if (value.requireHints !== undefined && typeof value.requireHints !== "boolean") {
    throw new Error(`context-broker catalog bundle "${recordName}" routing.requireHints must be a boolean`);
  }

  const groups = value.groups === undefined ? undefined : (() => {
    if (!Array.isArray(value.groups)) throw new Error(`context-broker catalog bundle "${recordName}" routing.groups must be an array`);
    return value.groups.map((group, index) => {
      if (!isRecord(group) || typeof group.id !== "string" || !group.id.trim()) {
        throw new Error(`context-broker catalog bundle "${recordName}" routing.groups[${index}] requires id`);
      }
      const label = routingText(group.label, `routing.groups[${index}].label`, recordName);
      const hint = routingText(group.hint, `routing.groups[${index}].hint`, recordName);
      return {
        id: group.id.trim(),
        ...(label ? { label } : {}),
        ...(hint ? { hint } : {}),
      };
    });
  })();

  const members = value.members === undefined ? undefined : (() => {
    if (!isRecord(value.members)) throw new Error(`context-broker catalog bundle "${recordName}" routing.members must be an object`);
    return Object.fromEntries(Object.entries(value.members).map(([memberName, member]) => {
      if (!memberName.trim() || !isRecord(member)) {
        throw new Error(`context-broker catalog bundle "${recordName}" routing member "${memberName}" must be an object`);
      }
      const hint = routingText(member.hint, `routing member "${memberName}" hint`, recordName);
      if (!hint) throw new Error(`context-broker catalog bundle "${recordName}" routing member "${memberName}" requires hint`);
      const group = routingText(member.group, `routing member "${memberName}" group`, recordName);
      return [memberName.trim(), { hint, ...(group ? { group } : {}) }];
    }));
  })();

  const limits = value.limits === undefined ? undefined : (() => {
    if (!isRecord(value.limits)) throw new Error(`context-broker catalog bundle "${recordName}" routing.limits must be an object`);
    const descriptionChars = routingLimit(value.limits.descriptionChars, "descriptionChars", recordName);
    const overviewChars = routingLimit(value.limits.overviewChars, "overviewChars", recordName);
    const groupHintChars = routingLimit(value.limits.groupHintChars, "groupHintChars", recordName);
    const memberHintChars = routingLimit(value.limits.memberHintChars, "memberHintChars", recordName);
    return {
      ...(descriptionChars ? { descriptionChars } : {}),
      ...(overviewChars ? { overviewChars } : {}),
      ...(groupHintChars ? { groupHintChars } : {}),
      ...(memberHintChars ? { memberHintChars } : {}),
    };
  })();

  return {
    ...(overview ? { overview } : {}),
    ...(rules ? { rules } : {}),
    ...(groups ? { groups } : {}),
    ...(members ? { members } : {}),
    ...(combinations ? { combinations } : {}),
    ...(typeof value.requireHints === "boolean" ? { requireHints: value.requireHints } : {}),
    ...(limits ? { limits } : {}),
  };
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
    name: skill.name,
    description: skill.description,
    path: skill.path,
    aliases: skill.aliases,
  };
}

function skillLookupKeys(skill: SkillRecord): string[] {
  return [skill.normalizedName, normalizeKey(basename(dirname(skill.path))), ...skill.normalizedAliases].filter(Boolean);
}

function buildSkillLookup(skills: SkillRecord[]): Map<string, SkillRecord> {
  const lookup = new Map<string, SkillRecord>();
  for (const skill of skills) {
    for (const key of skillLookupKeys(skill)) {
      if (!lookup.has(key)) lookup.set(key, skill);
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

function generatedBundleSource(path: string): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  const frontmatter = readFileSync(path, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter?.[1]) return undefined;
  try {
    const parsed = parseYaml(frontmatter[1]);
    if (!isRecord(parsed) || !isRecord(parsed.metadata)) return undefined;
    if (parsed.metadata["context-broker-owner"] !== "pi-context-broker") return undefined;
    const source = parsed.metadata["context-broker-source-bundle"];
    return typeof source === "string" && source.trim() ? source.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isGeneratedBundleSelf(path: string, recordName: string): boolean {
  return normalizeKey(generatedBundleSource(path) ?? "") === normalizeKey(recordName);
}

function membersFromInclude(include: string[], skillLookup: Map<string, SkillRecord>, skills: SkillRecord[], recordName: string): DiscoveryMember[] {
  const members: SkillRecord[] = [];
  const seen = new Set<string>();
  for (const memberName of include) {
    const matched = includePatternHasGlob(memberName)
      ? skills.filter((skill) => includePatternMatches(memberName, skill)).sort((left, right) => left.name.localeCompare(right.name))
      : [skillLookup.get(normalizeKey(memberName))].filter((skill): skill is SkillRecord => Boolean(skill));
    if (matched.length === 0) throw new Error(`context-broker catalog bundle "${recordName}" includes unknown skill: ${memberName}`);
    for (const skill of matched) {
      if (isGeneratedBundleSelf(skill.path, recordName) || seen.has(skill.path)) continue;
      seen.add(skill.path);
      members.push(skill);
    }
  }
  return members.map(memberFromSkill);
}

function memberFromRaw(value: unknown, catalogDir: string, scan: ScanConfig = {}): DiscoveryMember | undefined {
  if (!isRecord(value)) return undefined;
  const path = typeof value.path === "string" ? resolveCatalogPath(value.path, catalogDir) : "";
  const parsed = path ? skillRecordFromFile(path, false, undefined, scan) : undefined;
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : parsed?.name;
  if (!name) return undefined;
  return {
    name,
    description: typeof value.description === "string" && value.description.trim() ? value.description.trim() : parsed?.description ?? "",
    path,
    aliases: uniqueStrings([...(parsed?.aliases ?? []), ...stringArray(value.aliases)]),
  };
}

function bundleFromRaw(name: string | undefined, value: unknown, catalogPath: string, skills: SkillRecord[] = [], skillLookup = buildSkillLookup(skills), scan: ScanConfig = {}): BundleDiscoveryRecord | undefined {
  if (!isRecord(value)) return undefined;
  const catalogDir = dirname(catalogPath);
  const recordName = typeof value.name === "string" && value.name.trim() ? value.name.trim() : name;
  if (!recordName) return undefined;
  let members: DiscoveryMember[] = [];
  if (Array.isArray(value.members)) {
    members = value.members
      .map((member) => memberFromRaw(member, catalogDir, scan))
      .filter((member): member is DiscoveryMember => member !== undefined);
  } else if (isRecord(value.members) && Array.isArray(value.members.include)) {
    members = membersFromInclude(stringArray(value.members.include), skillLookup, skills, recordName);
  } else if ("members" in value) {
    throw new Error(`context-broker catalog bundle "${recordName}" members must be an array or { include: string[] }`);
  }
  members = members.filter((member) => !isGeneratedBundleSelf(member.path, recordName));
  return normalizeDiscoveryRecord({
    kind: "bundle",
    name: recordName,
    description: typeof value.description === "string" ? value.description.trim() : "",
    aliases: stringArray(value.aliases),
    path: catalogPath,
    normalizedName: "",
    normalizedAliases: [],
    normalizedDescription: "",
    render: isRecord(value.render) ? value.render as BundleDiscoveryRecord["render"] : { type: "member-index" },
    routing: routingFromRaw(value.routing, recordName),
    policy: isRecord(value.policy) ? value.policy as BundleDiscoveryRecord["policy"] : undefined,
    members,
  }) as BundleDiscoveryRecord;
}

export function readDiscoveryCatalog(path: string, skills: SkillRecord[] = [], scan: ScanConfig = {}): DiscoveryRecord[] {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath)) return [];
  const raw = readCatalogFile(absolutePath);
  if (!isRecord(raw)) return [];
  const records: DiscoveryRecord[] = [];
  const skillLookup = buildSkillLookup(skills);
  const rawRecords = Array.isArray(raw.records) ? raw.records : [];
  for (const rawRecord of rawRecords) {
    if (!isRecord(rawRecord)) continue;
    if (rawRecord.kind === "bundle") {
      const bundle = bundleFromRaw(undefined, rawRecord, absolutePath, skills, skillLookup, scan);
      if (bundle) records.push(bundle);
    }
  }
  if (isRecord(raw.bundles)) {
    for (const [name, value] of Object.entries(raw.bundles)) {
      const bundle = bundleFromRaw(name, value, absolutePath, skills, skillLookup, scan);
      if (bundle) records.push(bundle);
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

export async function buildDiscoveryRegistryFromParts(skills: SkillRecord[], catalogs: string[], scan: ScanConfig = {}): Promise<DiscoveryRecord[]> {
  return [
    ...dedupeRegistryByNormalizedName(skills).map(skillDiscoveryRecord),
    ...catalogs.flatMap((catalog) => readDiscoveryCatalog(catalog, skills, scan)),
  ].map(normalizeDiscoveryRecord);
}
