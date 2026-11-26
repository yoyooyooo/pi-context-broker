import { skillRefProtocol } from "./skill-ref-protocol.ts";

/** Profile, operation and File record IDs have the current wire contract's
 * bounded ASCII grammar. They are not Library root IDs or Skill IDs. */
export function validSharedRecordId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value);
}

/** Skill IDs use the selected protocol's stable lowercase grammar. */
export function validSharedSkillId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const protocol = skillRefProtocol();
  try { protocol.validateSkillId(value); return true; }
  catch { return false; }
}

export function sharedSkillId(libraryId: string, skillId: string): string | undefined {
  const protocol = skillRefProtocol();
  try { return protocol.formatSkillIdentity({ libraryId, skillId }); }
  catch { return undefined; }
}
