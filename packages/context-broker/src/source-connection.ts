import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { normalizeSources } from "./sources";
import type { ExtensionContext } from "./types";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const error = (code: string, message: string) => Object.assign(new Error(message), { code });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function readConfiguration(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw error("SOURCE_CONNECTION_UNSAFE_PATH", "Choose an ordinary config file, not a symlink or directory");
    return await readFile(path, "utf8");
  } catch (failure) {
    if (failure instanceof Error && "code" in failure && failure.code === "ENOENT") return null;
    throw failure;
  }
}

/** Preview and apply share the exact selected file and content digest. This
 * changes configuration only; remote readiness and body delivery remain separate. */
export async function connectNotionSource(input: { source: string; entry: string; configPath: string; apply?: string }) {
  if (!/^[\p{L}\p{N}._-]+$/u.test(input.source) || !input.entry || /\s|\0/u.test(input.entry) || input.entry.length > 2048)
    throw error("INVALID_ARGUMENT", "Choose a source ID and the single library entry returned by init/attach");
  if (!isAbsolute(input.configPath) || ![".json", ".yaml", ".yml"].includes(extname(input.configPath)))
    throw error("SOURCE_CONNECTION_CONFIG_REQUIRED", "Choose one absolute .json/.yaml/.yml config file using --config or CONTEXT_BROKER_CONFIG");
  const original = await readConfiguration(input.configPath);
  let parsed: unknown;
  try { parsed = original === null ? {} : extname(input.configPath) === ".json" ? JSON.parse(original) : parseYaml(original); }
  catch { throw error("SOURCE_CONFIG_INVALID", "The selected file is not valid JSON or YAML. Correct that file before connecting a source."); }
  if (!object(parsed)) throw error("SOURCE_CONFIG_INVALID", "The selected config must be an object");
  const sources = normalizeSources(parsed.sources) ?? [];
  const previous = sources.find(source => source.id === input.source);
  if (previous && (previous.type !== "notion" || previous.database !== input.entry || previous.enabled === false))
    throw error("SOURCE_CONNECTION_CONFLICT", "This source ID already has a different or disabled configuration. Choose a new ID or edit it explicitly.");
  const duplicate = sources.find(source => source.id !== input.source && ((source.namespace ?? source.id) === input.source
    || source.type === "notion" && source.database === input.entry));
  if (duplicate) throw error("SOURCE_CONNECTION_CONFLICT", `The entry or namespace is already configured as ${duplicate.id}; reuse that source.`);
  const proposed = { id: input.source, type: "notion", database: input.entry, prefetch: false };
  const digest = hash(JSON.stringify([input.configPath, original, proposed]));
  const changed = previous === undefined;
  let backupPath: string | undefined;
  if (input.apply !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(input.apply) || input.apply !== digest) throw error("SOURCE_CONNECTION_STALE_PREVIEW", "The selected configuration or proposed source changed. Review a new preview.");
    if (changed) {
      const next = { ...parsed, sources: [...(Array.isArray(parsed.sources) ? parsed.sources : []), proposed] };
      const contents = extname(input.configPath) === ".json" ? JSON.stringify(next, null, 2) + "\n" : stringifyYaml(next);
      await mkdir(dirname(input.configPath), { recursive: true });
      if (original === null) await writeFile(input.configPath, contents, { flag: "wx", mode: 0o600 });
      else {
        if (await readConfiguration(input.configPath) !== original) throw error("SOURCE_CONNECTION_STALE_PREVIEW", "The config changed after preview; no update was made.");
        backupPath = input.configPath + ".before-connect-" + randomUUID();
        await writeFile(backupPath, original, { flag: "wx", mode: 0o600 });
        const staging = input.configPath + ".pending-" + randomUUID();
        await writeFile(staging, contents, { flag: "wx", mode: 0o600 });
        if (await readConfiguration(input.configPath) !== original) throw error("SOURCE_CONNECTION_STALE_PREVIEW", "The config changed during apply. The original and staged copy are preserved.");
        await rename(staging, input.configPath);
      }
    }
  }
  const applied = input.apply !== undefined;
  return { version: 1, kind: "source_connection", status: applied ? changed ? "configuration_saved" : "already_configured" : "preview",
    source: { id: input.source, type: "notion", database: input.entry, prefetch: previous?.prefetch ?? false },
    config_path: input.configPath, preview_sha256: digest, changed: applied && changed, ...(backupPath ? { backup_path: backupPath } : {}),
    remote_library: "not_verified", local_registration: applied || previous !== undefined ? "configured" : "not_configured",
    pi_connection: "reload_required", body_read: "not_observed", remote_writes: "none",
    concurrent_edit_precondition: original === null ? "exclusive_create" : "digest_recheck_not_atomic",
    next: applied ? ["Restart Pi with CONTEXT_BROKER_CONFIG set to config_path, or /reload when it already names this file.", "/context-broker doctor", "Use notion_list to discover metadata; read an exact returned ref for an introduction, or notion_use to apply its instructions."]
      : [`/context-broker connect ${input.source} ${input.entry} --config ${JSON.stringify(input.configPath)} --apply ${digest}`, "Run the apply command only after accepting this selected config and source."] };
}

export async function handleSourceConnection(args: string, ctx: ExtensionContext): Promise<boolean> {
  if (args.trim().split(/\s+/, 1)[0] !== "connect") return false;
  try {
    const tokens: string[] = [];
    let end = 0;
    for (const match of args.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+/gu)) {
      if (args.slice(end, match.index).trim()) throw error("INVALID_ARGUMENT", "Unclosed command argument; quote paths with JSON double quotes");
      const token = match[0];
      tokens.push(token.startsWith('"') ? JSON.parse(token) : token.startsWith("'") ? token.slice(1, -1) : token);
      end = match.index! + token.length;
    }
    if (args.slice(end).trim()) throw error("INVALID_ARGUMENT", "Unclosed command argument; quote paths with JSON double quotes");
    const [, source, entry, ...flags] = tokens;
    let configPath = process.env.CONTEXT_BROKER_CONFIG, apply: string | undefined;
    const used = new Set<string>();
    for (let index = 0; index < flags.length; index += 2) {
      const key = flags[index], value = flags[index + 1];
      if (!key || used.has(key) || !value || !["--config", "--apply"].includes(key)) throw error("INVALID_ARGUMENT", "Usage: /context-broker connect SOURCE ENTRY [--config ABSOLUTE_FILE] [--apply PREVIEW_SHA256]");
      used.add(key);
      if (key === "--config") configPath = value;
      else apply = value;
    }
    if (!source || !entry || !configPath) throw error("SOURCE_CONNECTION_CONFIG_REQUIRED", "Usage: /context-broker connect SOURCE ENTRY --config /absolute/config.json. Preview first; no default or global config is selected implicitly.");
    const result = await connectNotionSource({ source, entry, configPath, apply });
    ctx.ui?.notify?.(JSON.stringify(result, null, 2), "info");
  } catch (failure) {
    ctx.ui?.notify?.(failure instanceof Error ? failure.message : "Source configuration failed", "error");
  }
  return true;
}
