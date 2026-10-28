import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SourceConfig } from "./types";

export type CliScope = { command: string[]; database?: string; sourceId?: string };
export class HostCommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "HostCommandError"; }
}
export function hostCliScope(sources: SourceConfig[] = []): CliScope {
  const configured = sources.filter(source => source.type === "notion" && source.enabled !== false);
  if (configured.length > 1) throw new HostCommandError("HOST_SOURCE_AMBIGUOUS", "Choose a Notion source explicitly; multiple source commands cannot be selected implicitly.");
  const source = configured[0];
  if (source?.type === "notion" && source.command) return { command: typeof source.command === "string" ? [source.command] : [...source.command], database: source.database, sourceId: source.id };
  const adjacent = fileURLToPath(new URL("./ntn-skills.mjs", import.meta.url));
  const entry = existsSync(adjacent) ? adjacent : fileURLToPath(new URL("../dist/ntn-skills.mjs", import.meta.url));
  if (!existsSync(entry)) throw new HostCommandError("HOST_CLI_UNAVAILABLE", "Bundled ntn-skills CLI is unavailable. Reinstall pi-context-broker.");
  return { command: [process.versions.bun ? "node" : process.execPath, entry], ...(source?.type === "notion" ? { database: source.database, sourceId: source.id } : {}) };
}
