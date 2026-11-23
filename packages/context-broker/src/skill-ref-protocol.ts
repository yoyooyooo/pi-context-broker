import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Structural types at the selected-package boundary. The implementation and
 * all validation belong to the copied ntn-skills/ref module. */
export type SkillKey = Readonly<{ libraryId: string; skillId: string }>;
export type ReferenceSelection = Readonly<{ kind: "current" }> | Readonly<{ kind: "fixed"; snapshotId: string }>;
export type ParsedSkillRef = Readonly<{
  skillId: string;
  scope: Readonly<{ kind: "context" }> | Readonly<{ kind: "library"; libraryId: string }>;
  path: string;
  selection: ReferenceSelection;
}>;
export type BoundSkillRef = Readonly<{ owner: SkillKey; path: string; selection: ReferenceSelection }>;
type Protocol = {
  SKILL_REF_VERSION: 2;
  createSkillKey(input: SkillKey): SkillKey;
  parseSkillRef(input: string): ParsedSkillRef;
  bindSkillRef(reference: ParsedSkillRef, contextLibraryId?: string): BoundSkillRef;
  formatSkillRef(reference: ParsedSkillRef | BoundSkillRef): string;
  formatSkillIdentity(input: SkillKey): string;
  parseSkillIdentity(input: string): SkillKey;
  sameSkillKey(left: SkillKey, right: SkillKey): boolean;
  normalizeSkillPath(input: string, base?: string): string;
  skillRefPath(reference: ParsedSkillRef | BoundSkillRef): string;
  skillRefSnapshot(reference: ParsedSkillRef | BoundSkillRef): string | undefined;
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
function compatible(value: unknown): value is Protocol {
  return object(value) && value.SKILL_REF_VERSION === 2 && ["createSkillKey", "parseSkillRef", "bindSkillRef",
    "formatSkillRef", "formatSkillIdentity", "parseSkillIdentity", "sameSkillKey", "normalizeSkillPath",
    "skillRefPath", "skillRefSnapshot"].every(name => typeof value[name] === "function");
}
function unavailable(): never {
  throw Object.assign(new Error("The selected Skill reference protocol is unavailable or incompatible"), { code: "SOURCE_SDK_INCOMPATIBLE" });
}
let loaded: Protocol | undefined;

/** Synchronous and package-local: never resolve a second installed package. */
export function skillRefProtocol(): Protocol {
  if (loaded) return loaded;
  const adjacent = new URL("./ntn-skills-ref.cjs", import.meta.url);
  const location = existsSync(fileURLToPath(adjacent)) ? adjacent : new URL("../dist/ntn-skills-ref.cjs", import.meta.url);
  try {
    const bytes = readFileSync(location);
    const manifest: unknown = JSON.parse(readFileSync(new URL("./ntn-skills-runtime.json", location), "utf8"));
    if (!object(manifest) || manifest.version !== 1 || manifest.package !== "ntn-skills" || manifest.skill_ref_version !== 2
      || manifest.ref_sha256 !== createHash("sha256").update(bytes).digest("hex")) return unavailable();
    const value: unknown = createRequire(import.meta.url)(fileURLToPath(location));
    if (!compatible(value)) return unavailable();
    loaded = value;
    return value;
  } catch { return unavailable(); }
}
