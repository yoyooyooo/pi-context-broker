import { readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ScanConfig, SkillMetadata, SkillRecord } from "./types";

const DEFAULT_SCAN_IGNORE = [".git", "node_modules", "dist", "build", "coverage"];
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_SKILL_BYTES = 64 * 1024;

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Local names use the CLI display-name/alias contract; remote aliases stay opaque. */
export function normalizeKey(value: string): string {
  if (!/\S/u.test(value) || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return "";
  const normalized = value.normalize("NFC").toLowerCase().trim().replace(/\s+/gu, "-");
  return Array.from(normalized, (character, index) =>
    /^[\p{L}\p{M}\p{N}_-]$/u.test(character) && !(index === 0 && character === "-")
      ? character
      : encodeURIComponent(character).replace(/[!'()*-]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`),
  ).join("");
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
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name : basename(dirname(path));
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
  async function walk(dir: string, depth: number, ancestors: Set<string>): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    let physicalPath: string;
    try {
      physicalPath = await realpath(dir);
      if (ancestors.has(physicalPath)) return;
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const nextAncestors = new Set(ancestors).add(physicalPath);
    for (const entry of entries) {
      if (entry.name.startsWith(".") && ignored.has(entry.name)) continue;
      if (ignored.has(entry.name)) continue;
      const path = join(dir, entry.name);
      const target = entry.isSymbolicLink() ? await stat(path).catch(() => undefined) : entry;
      if (!target) continue;
      // Keep the discovered path for relative references; realpath only guards cycles.
      if (target.isDirectory()) {
        await walk(path, depth + 1, nextAncestors);
      } else if (target.isFile() && entry.name === "SKILL.md") {
        files.push(path);
      }
    }
  }
  await walk(root, 0, new Set());
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
  if (!normalizeKey(metadata.name)) return undefined;
  return {
    ...metadata,
    kind: "skill",
    id: `local:${resolve(path)}`,
    locator: { type: "local", id: resolve(path), entry: path },
    source: "local",
    alias: normalizeKey(metadata.name),
    entrypoint: "SKILL.md",
    ref: path,
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

/** Local symlink aliases share one physical Skill; source identities stay independent. */
export function dedupeLocalSkillPaths<T extends SkillRecord>(records: T[]): T[] {
  const paths = new Set<string>();
  return records.filter(record => {
    if (record.sourceId) return true;
    let path: string;
    try { path = realpathSync(record.path); }
    catch { path = resolve(record.path); }
    if (paths.has(path)) return false;
    paths.add(path);
    return true;
  });
}

