import { resolve } from "node:path";
import { buildDollarRegistry, readConfig } from "./index";
import { dollarAutocompleteItems, extractDollarAutocompletePrefix } from "./dollar";
import type { AutocompleteItem, ConfigFile, ContentKind, HostPathOptions, SourceFailure } from "./types";

export type CompletionRequest = {
  version: 1;
  text: string;
  cursor: number;
  cwd: string;
  config?: string;
};
export type ContentCompletionItem = AutocompleteItem & { identity: string; kind: ContentKind; source: "local" | "notion"; ref: string };
export type CompletionResponse = {
  version: 1;
  edit: { from: number; to: number; len: number; prefix: string } | null;
  items: ContentCompletionItem[];
  failures?: SourceFailure[];
};

export function parseCompletionRequest(value: unknown): CompletionRequest {
  if (!value || typeof value !== "object") throw new Error("Expected a completion request object");
  if (!("version" in value) || value.version !== 1) throw new Error("Unsupported completion protocol version");
  if (!("text" in value) || typeof value.text !== "string") throw new Error("text must be a string");
  if (!("cursor" in value) || typeof value.cursor !== "number" || !Number.isInteger(value.cursor) || value.cursor < 0 || value.cursor > value.text.length) {
    throw new Error("cursor must be a UTF-16 offset within text");
  }
  if (!("cwd" in value) || typeof value.cwd !== "string" || !value.cwd) throw new Error("cwd must be a nonempty path");
  if ("config" in value && value.config !== undefined && (typeof value.config !== "string" || !value.config)) throw new Error("config must be a nonempty path");
  const previous = value.text.charCodeAt(value.cursor - 1);
  const next = value.text.charCodeAt(value.cursor);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) throw new Error("cursor splits a surrogate pair");
  return {
    version: 1, text: value.text, cursor: value.cursor, cwd: value.cwd,
    ...("config" in value && typeof value.config === "string" ? { config: value.config } : {}),
  };
}

export async function completeDollarRequest(request: CompletionRequest, config?: ConfigFile, paths: HostPathOptions = {}): Promise<CompletionResponse> {
  config ??= readConfig({ ...paths, configPath: request.config ?? paths.configPath });
  const beforeCursor = request.text.slice(0, request.cursor);
  const prefix = extractDollarAutocompletePrefix(beforeCursor.slice(beforeCursor.lastIndexOf("\n") + 1));
  if (prefix === undefined) return { version: 1, edit: null, items: [] };
  const { records: registry, failures } = await buildDollarRegistry(config, resolve(request.cwd), paths);
  return {
    version: 1,
    edit: { from: request.cursor - prefix.length, to: request.cursor, len: request.text.length, prefix },
    items: dollarAutocompleteItems(registry, prefix.slice(1), { precise: true }),
    ...(failures.length ? { failures } : {}),
  };
}
