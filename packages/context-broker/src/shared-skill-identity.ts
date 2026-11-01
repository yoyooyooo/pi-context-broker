/** Match the CLI's bounded shared identities before encoding each component. */
export function validSharedIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(value);
}

export function sharedSkillId(libraryId: string, skillId: string): string | undefined {
  return validSharedIdentity(libraryId) && validSharedIdentity(skillId)
    ? `shared_skill:${encodeURIComponent(libraryId)}:${encodeURIComponent(skillId)}`
    : undefined;
}
