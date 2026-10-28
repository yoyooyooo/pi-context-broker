import { dirname } from "node:path";
import type { HostCapabilities } from "./host-adapter";
import type { ExtensionAPI, SkillRecord } from "./types";
import { installPiDollarAutocompleteEditor } from "./pi-dollar-editor";

const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function createPiHostAdapter(api: ExtensionAPI): HostCapabilities {
  let records: SkillRecord[] = [];
  api.on("resources_discover", () => ({ skillPaths: records.map(record => record.metadataIndexPath ?? record.path) }));
  return {
    paths: { host: "pi" },
    submission: { mode: "transform", receipt: "input-digest" },
    handledInput: { action: "handled" }, continuedInput: { action: "continue" },
    transformInput(text, images) { return { action: "transform", text, images }; },
    async registerCatalog(next) { records = next.filter(record => record.kind === undefined || record.kind === "skill"); return true; },
    skillInstructions(_record, { directory, directoryRedacted }) {
      return [
        "<instructions>The complete Skill entry is loaded below. Use it directly for the current task; no further entry read or directory inspection is needed to load it.</instructions>",
        `<skill-directory>${escapeText(directory)}</skill-directory>`,
        `<resources>${directoryRedacted ? "The local directory is hidden by pathMode. Use the supplied CLI resource-read-args and database scope: read SNAPSHOT --path RELATIVE reads a named file; files SNAPSHOT lists resources when needed. SNAPSHOT is provided above. Keep JSON output to check ok/error and the selected version. Discover other Skills through the CLI, not neighboring cache records." : "Read a requested relative file directly from the Skill directory above, expanding ~ to the home directory. Do not first list directories or search the cwd to locate an already named file. Discover other Skills through metadata or the CLI, not neighboring cache records. Inspection and introduction do not execute this workflow or discover its prerequisites."}</resources>`,
      ];
    },
    async buildPrompt(snapshot, args, _prompt, metadata = snapshot) {
      const path = metadata.metadataIndexPath ?? metadata.path;
      const name = (metadata.token ?? metadata.name).replace(/[^a-z0-9-]/g, "-");
      const body = snapshot.body!.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
      const block = `<skill name="${name}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`;
      return args ? `${block}\n\n${args}` : block;
    },
    async installEditor(ctx, bind) {
      if (ctx.hasUI) await installPiDollarAutocompleteEditor(ctx, bind);
    },
    updatedRead() { return undefined; },
    async reload(ctx) {
      await ctx?.reload?.();
    },
  };
}
