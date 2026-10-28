import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillRecordFromFile } from "./skill-records";
import type { ScanConfig, SkillRecord } from "./types";

export const BUNDLED_SKILL_NAMES: readonly string[] = [
  "ntn-skills",
  "ntn-skills-maintain",
  "ntn-skills-sync",
];

/** Bundled content is an ordinary local Skill with its own package identity. */
export function isBundledBuiltinToken(query: string): boolean {
  return BUNDLED_SKILL_NAMES.some(name => query === `${name}@builtin`);
}

export function isBundledBuiltin(record: SkillRecord): boolean {
  return !record.sourceId && record.source === "local"
    && record.id === "builtin:" + record.alias
    && BUNDLED_SKILL_NAMES.includes(record.alias ?? "");
}

export function bundledBuiltinRoot(moduleUrl: string = import.meta.url): string | undefined {
  // Adjacent in Tern's bundled query; dist/ beside the npm package's src/.
  return ["./builtin-skills/", "../dist/builtin-skills/"]
    .map(relative => fileURLToPath(new URL(relative, moduleUrl)))
    .find(path => existsSync(join(path, "ntn-skills", "SKILL.md")));
}

export function readBundledBuiltinRecords(root: string, requireAutoload = false, options: ScanConfig = {}): SkillRecord[] {
  const records: SkillRecord[] = [];
  for (const name of BUNDLED_SKILL_NAMES) {
    const record = skillRecordFromFile(join(root, name, "SKILL.md"), requireAutoload, undefined, options);
    if (!record) continue;
    records.push({
      ...record,
      id: "builtin:" + name,
      alias: name,
      token: "builtin/" + name,
      selectionToken: name + "@builtin",
    });
  }
  return records;
}

export function bundledBuiltinRecords(requireAutoload = false, options: ScanConfig = {}): SkillRecord[] {
  const root = bundledBuiltinRoot();
  return root ? readBundledBuiltinRecords(root, requireAutoload, options) : [];
}
