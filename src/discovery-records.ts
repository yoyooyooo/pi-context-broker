import { existsSync, readFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { BundleDiscoveryRecord, ConfigFile, DiscoveryMember, DiscoveryRecord, ScanConfig, SkillRecord } from "./types";
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
  const seen = new Set<string>();
  const result: DiscoveryRecord[] = [];
  for (const record of records) {
    const key = recordNormalizedName(record);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
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
      errors.push(`name collision: ${recordKind(existing)} "${recordName(existing)}" conflicts with ${recordKind(record)} "${recordName(record)}"`);
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

function membersFromInclude(include: string[], skillLookup: Map<string, SkillRecord>, skills: SkillRecord[], recordName: string): DiscoveryMember[] {
  const members: SkillRecord[] = [];
  const seen = new Set<string>();
  for (const memberName of include) {
    const matched = includePatternHasGlob(memberName)
      ? skills.filter((skill) => includePatternMatches(memberName, skill)).sort((left, right) => left.name.localeCompare(right.name))
      : [skillLookup.get(normalizeKey(memberName))].filter((skill): skill is SkillRecord => Boolean(skill));
    if (matched.length === 0) throw new Error(`context-broker catalog bundle "${recordName}" includes unknown skill: ${memberName}`);
    for (const skill of matched) {
      if (seen.has(skill.path)) continue;
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
