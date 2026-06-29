import { existsSync } from "node:fs";
import { dollarAutocompleteItems } from "./dollar";
import {
  buildRegistryFromRoots,
  compactPath,
  normalizeKey,
  skillSourceLabel,
} from "./skill-records";
import type { DiscoveryRecord, SkillRecord } from "./types";
import { recordDescription, recordKind, recordName, recordNormalizedName, recordPath } from "./discovery-records";

type RootDiagnostic = {
  root: string;
  label: string;
  exists: boolean;
  skillCount: number;
};

function rootLabel(root: string): string {
  const compact = compactPath(root);
  if (compact.includes("/.codex/plugins/cache")) return "codex-plugin";
  if (compact.endsWith("/.pi/agent/skills")) return "pi";
  if (compact.endsWith("/.omp/agent/skills")) return "omp";
  if (compact.endsWith("/.agents/skills")) return ".agents";
  if (compact.endsWith("/.agent/skills")) return ".agent";
  if (compact.endsWith("/.codex/skills")) return "codex";
  if (compact.endsWith("/.claude/skills")) return "claude";
  if (compact.endsWith("/.pi/skills")) return "project:.pi";
  if (compact.endsWith("/.omp/skills")) return "project:.omp";
  return "custom";
}

function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function takeColumns(value: string, maxColumns: number): string {
  let width = 0;
  let result = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    const charWidth = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? 0
      : isWideCodePoint(codePoint) ? 2 : 1;
    if (width + charWidth > maxColumns) break;
    width += charWidth;
    result += char;
  }
  return result;
}

function truncateEndColumns(value: string, maxColumns: number): string {
  if (displayWidth(value) <= maxColumns) return value;
  if (maxColumns <= 3) return takeColumns(value, maxColumns);
  return `${takeColumns(value, maxColumns - 3).trimEnd()}...`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 5) return truncateEnd(value, maxLength);
  const left = Math.ceil((maxLength - 3) / 2);
  const right = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

export async function collectRootDiagnostics(roots: string[]): Promise<RootDiagnostic[]> {
  return Promise.all(roots.map(async (root) => {
    const exists = existsSync(root);
    const skillCount = exists ? (await buildRegistryFromRoots([root], false)).length : 0;
    return {
      root,
      label: rootLabel(root),
      exists,
      skillCount,
    };
  }));
}

export function formatRootDiagnostics(roots: RootDiagnostic[], limit = 24): string {
  const existing = roots.filter((root) => root.exists);
  const totalSkills = roots.reduce((sum, root) => sum + root.skillCount, 0);
  const lines = [
    `context-broker roots: ${existing.length}/${roots.length} exists, ${totalSkills} raw skills`,
    ...roots.slice(0, limit).map((root) => {
      const mark = root.exists ? "ok" : "missing";
      const label = truncateEnd(root.label, 20).padEnd(20);
      const path = truncateMiddle(compactPath(root.root), 40);
      return truncateEndColumns(`${mark.padEnd(7)} ${String(root.skillCount).padStart(3)} ${label} ${path}`, 78);
    }),
  ];
  if (roots.length > limit) lines.push(`... ${roots.length - limit} more roots`);
  return lines.join("\n");
}

function compactDescription(value: string, maxColumns: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return truncateEndColumns(compact, maxColumns);
}

function skillLine(skill: DiscoveryRecord, duplicateCount: number): string {
  const kind = recordKind(skill);
  const label = kind === "bundle" ? `bundle ${(skill as any).members?.length ?? 0}m` : skillSourceLabel(recordPath(skill)) ?? "custom";
  const name = truncateEndColumns(`$${recordName(skill)}`, 26);
  const metadata = truncateEndColumns(duplicateCount > 1 ? `${label} d${duplicateCount}` : label, 16);
  const path = truncateMiddle(compactPath(recordPath(skill)), 18);
  const prefix = `${name} [${metadata}] ${path}`;
  const descriptionColumns = 78 - displayWidth(prefix) - 3;
  const description = descriptionColumns >= 8 ? compactDescription(recordDescription(skill), descriptionColumns) : "";
  const detail = description ? ` - ${description}` : "";
  return truncateEndColumns(`${prefix}${detail}`, 78);
}

export function formatFindDiagnostics(
  query: string,
  registry: DiscoveryRecord[],
  rawRegistry: DiscoveryRecord[] = registry,
  limit = 8,
): string {
  const cleanQuery = query.replace(/^\$/, "").trim();
  if (!cleanQuery) return "context-broker find: query required";
  const byName = new Map(registry.map((skill) => [recordNormalizedName(skill), skill]));
  const duplicateCounts = new Map<string, number>();
  for (const skill of rawRegistry) {
    duplicateCounts.set(recordNormalizedName(skill), (duplicateCounts.get(recordNormalizedName(skill)) ?? 0) + 1);
  }
  const matches = dollarAutocompleteItems(registry, cleanQuery)
    .map((item) => byName.get(normalizeKey(item.value.slice(1))))
    .filter((skill): skill is DiscoveryRecord => skill !== undefined)
    .slice(0, limit);
  if (matches.length === 0) return `context-broker find: no match for ${cleanQuery}`;
  return [
    `context-broker find: ${cleanQuery} -> ${matches.length}/${registry.length}`,
    ...matches.map((skill) => skillLine(skill, duplicateCounts.get(recordNormalizedName(skill)) ?? 1)),
  ].join("\n");
}
