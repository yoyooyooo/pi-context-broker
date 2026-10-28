import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HostCapabilities } from "./host-adapter";
import type { ExtensionAPI } from "./types";

const LOADED_SKILL_RULES = [
  "# Loaded Skills",
  "A complete Skill body supplied by the host or Context Broker in the current active context satisfies the requirement to read that Skill before use. Follow the supplied instructions directly; do not reread the same entry, list its cache directory, or inspect package metadata just to load or identify it again.",
  "Read additional resources when the task needs them, resolving relative paths from the supplied Skill directory. Catalog descriptions and Router member indexes do not supply member Skill bodies. If a Skill body is absent after compaction or a branch change, read it normally before use.",
].join("\n");
const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

type Setting = { get(settings: unknown): unknown; override(settings: unknown, value: unknown): void };
export function createOmpHostAdapter(api: ExtensionAPI): HostCapabilities {
  const native = api.pi!;
  let setting: Setting | undefined;
  let installed = new Set<string>();
  const aliases = new Map<string, string[]>();
  const installedEditors = new WeakSet<object>();
  return {
    paths: { host: "omp", agentDir: native.getAgentDir?.() },
    submission: { mode: "command", receipt: "handoff" },
    headlessActivationTimeoutMs: 25_000,
    metadataDiscovery: "deferred",
    handledInput: { handled: true }, continuedInput: undefined,
    transformInput(text, images) { return { text, ...(images ? { images } : {}) }; },
    skillInstructions(record, { query, directory, directoryRedacted }) {
      return [
        `<invocation>${escapeText(query)}</invocation>`,
        ...(record.sourceId ? [`<host-skill>${escapeText((record.token ?? record.name).replace(/[^a-z0-9-]/g, "-"))}</host-skill>`] : []),
        "<instructions>The complete Skill entry is loaded below. Use it directly; no further entry read or cache/metadata inspection is needed to load this Skill.</instructions>",
        `<skill-directory>${escapeText(directory)}</skill-directory>`,
        `<resources>${directoryRedacted ? "The local directory is hidden by pathMode. Use the supplied CLI resource-read-args and database scope: read SNAPSHOT --path RELATIVE reads a named file; files SNAPSHOT lists resources when needed. SNAPSHOT is provided above. Keep JSON output to check ok/error and the selected version. Discover other Skills through the CLI, not neighboring cache records." : "Resolve relative resource paths from the Skill directory above, expanding ~ to the home directory. Read named files directly when the current task needs them. Discover other Skills through metadata or the CLI, not neighboring cache records. Inspection and introduction do not execute this workflow or discover its prerequisites."}</resources>`,
      ];
    },
    systemPrompt(prompt) {
      return Array.isArray(prompt) ? [...prompt, LOADED_SKILL_RULES] : `${prompt}\n\n${LOADED_SKILL_RULES}`;
    },
    async installEditor(ctx, bind) {
      if (!ctx.hasUI || !ctx.ui?.setEditorComponent || installedEditors.has(ctx.ui)) return;
      // OMP editor imports are unavailable in the Pi distribution.
      const { installOmpDollarAutocompleteEditor } = await import("./omp-dollar-editor");
      if (await installOmpDollarAutocompleteEditor(ctx, bind)) installedEditors.add(ctx.ui);
    },
    async registerCatalog(records, signal) {
      records = records.filter(record => record.kind === undefined || record.kind === "skill");
      if (!native.settings) return false;
      if (!records.some(record => record.metadataIndexPath) && !installed.size) return true;
      if (!setting) {
        // OMP-only optional peer cannot be statically imported by the Pi distribution.
        try { setting = (await import("@oh-my-pi/pi-coding-agent/config/registry")).lookup("skills.customDirectories") as Setting | undefined; }
        catch { return false; }
      }
      if (!setting) return false;
      const current = setting.get(native.settings);
      const others = Array.isArray(current) ? current.filter((path): path is string => typeof path === "string" && !installed.has(path)) : [];
      const root = await mkdtemp(join(tmpdir(), "context-broker-omp-defaults-"));
      aliases.clear();
      for (const [index, record] of records.entries()) {
        const directory = join(root, String(index));
        if (record.metadataIndexPath) await symlink(dirname(resolve(record.metadataIndexPath)), directory, "dir");
        else { await mkdir(directory); await symlink(resolve(record.path), join(directory, "SKILL.md")); }
        aliases.set(record.metadataIndexPath ?? record.path, [join(directory, "SKILL.md")]);
      }
      const next = new Set(records.length ? [root] : []);
      signal?.throwIfAborted();
      // OMP scans child entries only; this root contains exclusively eligible metadata.
      setting.override(native.settings, [...new Set([...others, ...next])]);
      installed = next;
      // Deferred publication may finish after the host's startup catalog snapshot.
      return false;
    },
    catalogPaths(record) { return aliases.get(record.metadataIndexPath ?? record.path) ?? []; },
    async buildPrompt(snapshot, args, prompt) {
      if (!native.buildSkillPromptMessage) throw Object.assign(new Error("HOST_SKILL_API_UNAVAILABLE"), { code: "HOST_SKILL_API_UNAVAILABLE" });
      return (await native.buildSkillPromptMessage({ name: snapshot.name, filePath: snapshot.path, baseDir: dirname(snapshot.path) }, { args, prompt })).message;
    },
    updatedRead(input) { return { input }; },
    async reload(ctx) {
      await ctx?.reload?.();
    },
  };
}
