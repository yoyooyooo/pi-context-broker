import { skillRefProtocol } from "./skill-ref-protocol.ts";

/** Library identities retain their declared grammar; Skill IDs use the shared
 * protocol's stable lowercase grammar. Neither validator performs discovery. */
export function validSharedIdentity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const protocol = skillRefProtocol();
  try { protocol.createSkillKey({ libraryId: value, skillId: "identity-probe" }); return true; }
  catch { return false; }
}

export function sharedSkillId(libraryId: string, skillId: string): string | undefined {
  const protocol = skillRefProtocol();
  try { return protocol.formatSkillIdentity({ libraryId, skillId }); }
  catch { return undefined; }
}
