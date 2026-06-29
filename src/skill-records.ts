import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ScanConfig, SkillMetadata, SkillRecord } from "./types";

const DEFAULT_SCAN_IGNORE = [".git", "node_modules", "dist", "build", "coverage"];
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_SKILL_BYTES = 64 * 1024;

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeKey(value: string): string {
  return value
    .trim()
    .replace(/^[`"'([{（【]+|[`"',，。.!！？?；;、:：)）\]】}]+$/gu, "")
    .replace(/\s+(?:skill|技能)$/iu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function compactPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function skillSourceLabel(path: string): string | undefined {
  const compact = compactPath(path);
  if (compact.includes("/.codex/plugins/cache/")) return "codex-plugin";
  if (compact.includes("/.pi/agent/skills/")) return "pi";
  if (compact.includes("/.omp/agent/skills/")) return "omp";
  if (compact.includes("/.agents/skills/")) return ".agents";
  if (compact.includes("/.agent/skills/")) return ".agent";
  if (compact.includes("/.codex/skills/")) return "codex";
  if (compact.includes("/.claude/skills/")) return "claude";
  if (compact.includes("/.pi/skills/")) return "project:.pi";
  if (compact.includes("/.omp/skills/")) return "project:.omp";
  return undefined;
}

function parseFrontmatter(source: string): Record<string, unknown> {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) return {};
  const end = source.search(/\r?\n---\r?\n/);
  if (end < 0) return {};
  const raw = source.slice(source.indexOf("\n") + 1, end);
  try {
    const parsed = parseYaml(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function metadataFromSkill(path: string, body: string): SkillMetadata | undefined {
  const frontmatter = parseFrontmatter(body);
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : basename(dirname(path));
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  const autoload = frontmatter.autoload && typeof frontmatter.autoload === "object" ? frontmatter.autoload as Record<string, unknown> : {};
  const autoloadEnabled = autoload.enabled === true || process.env.CONTEXT_BROKER_REQUIRE_ENABLED === "0";
  const aliases = [
    ...stringArray(autoload.aliases),
    ...stringArray(autoload.alias),
  ];
  return { name, description, autoloadEnabled, aliases };
}

function scanIgnoreSet(options: ScanConfig = {}): Set<string> {
  return new Set([...(options.ignore ?? DEFAULT_SCAN_IGNORE)].filter(Boolean));
}

async function findSkillFiles(root: string, options: ScanConfig = {}): Promise<string[]> {
  const files: string[] = [];
  const ignored = scanIgnoreSet(options);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && ignored.has(entry.name)) continue;
      if (ignored.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(path);
      }
    }
  }
  await walk(root, 0);
  return files.sort();
}

export function skillRecordFromFile(
  path: string,
  requireAutoload: boolean,
  metadataOverride?: Partial<SkillMetadata>,
  options: ScanConfig = {},
): SkillRecord | undefined {
  let body: string;
  try {
    const maxBytes = options.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES;
    if (maxBytes > 0 && statSync(path).size > maxBytes) return undefined;
    body = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const parsedMetadata = metadataFromSkill(path, body);
  if (!parsedMetadata) return undefined;
  const metadata = {
    ...parsedMetadata,
    ...metadataOverride,
    aliases: uniqueStrings([...(parsedMetadata.aliases ?? []), ...(metadataOverride?.aliases ?? [])]),
  };
  if (requireAutoload && !metadata.autoloadEnabled) return undefined;
  return {
    ...metadata,
    path,
    body,
    normalizedName: normalizeKey(metadata.name),
    normalizedAliases: metadata.aliases.map(normalizeKey).filter(Boolean),
    normalizedDescription: normalizeKey(metadata.description),
  };
}

export async function buildRegistryFromRoots(roots: string[], requireAutoload: boolean, options: ScanConfig = {}): Promise<SkillRecord[]> {
  const records: SkillRecord[] = [];
  for (const root of roots) {
    const paths = await findSkillFiles(root, options);
    for (const path of paths) {
      const record = skillRecordFromFile(path, requireAutoload, undefined, options);
      if (record) records.push(record);
    }
  }
  return records;
}

export function dedupeRegistryByNormalizedName(registry: SkillRecord[]): SkillRecord[] {
  const seen = new Set<string>();
  const result: SkillRecord[] = [];
  for (const skill of registry) {
    if (seen.has(skill.normalizedName)) continue;
    seen.add(skill.normalizedName);
    result.push(skill);
  }
  return result;
}
