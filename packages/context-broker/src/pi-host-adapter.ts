import { dirname } from "node:path";
import type { HostCapabilities } from "./host-adapter";
import type { ExtensionAPI, SkillRecord } from "./types";
import { installPiDollarAutocompleteEditor } from "./pi-dollar-editor";

const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function createPiHostAdapter(api: ExtensionAPI): HostCapabilities {
  let records: SkillRecord[] = [];
  let discoveredPaths: string[] | undefined;
  api.on("resources_discover", () => {
    discoveredPaths = records.map(record => record.metadataIndexPath ?? record.path);
    return { skillPaths: discoveredPaths };
  });
  return {
    paths: { host: "pi" },
    submission: { mode: "transform", receipt: "input-digest" },
    metadataDiscovery: "deferred",
    handledInput: { action: "handled" }, continuedInput: { action: "continue" },
    transformInput(text, images) { return { action: "transform", text, images }; },
    async registerCatalog(next, signal) {
      signal?.throwIfAborted();
      records = next.filter(record => record.kind === undefined || record.kind === "skill");
      const paths = records.map(record => record.metadataIndexPath ?? record.path);
      // Pi 1.4 collects these paths only at startup/reload. Late metadata is
      // available through the broker prompt/read/input gates, not its native menu.
      return discoveredPaths === undefined || paths.length === discoveredPaths.length && paths.every((path, index) => path === discoveredPaths![index]);
    },
    skillInstructions(_record, { directory, directoryRedacted }) {
      return [
        "<instructions>The complete Skill entry is loaded below; no further entry read or directory inspection is needed to load it. Loading or selecting it does not authorize executing its workflow. Follow the user's current task: when asked to inspect, introduce or explain it, describe its instructions as source content without performing its prerequisite checks, commands, writes or delegation.</instructions>",
        `<skill-directory>${escapeText(directory)}</skill-directory>`,
        `<resources>${directoryRedacted ? "The local directory display is redacted, not a readable filesystem path. Use the current host guidance's available route with the supplied fixed resource ref or the owner and snapshot from skill-ref. Never append a file path to an sr: handle. A named resource must stay on this selected version; do not inspect neighboring cache records." : "Use the current host guidance's available route to read a requested relative file from the Skill directory above, expanding ~ to the home directory. Do not first list directories or search the cwd to locate an already named file. Discover other Skills through available metadata tools, not neighboring cache records."}</resources>`,
      ];
    },
    async buildPrompt(snapshot, args, _prompt, metadata = snapshot) {
      // The selected immutable directory survives host-index re-registration.
      // A persisted native invocation must not point at an ephemeral index alias.
      const path = snapshot.path;
      const name = (metadata.token ?? metadata.name).replace(/[^a-z0-9-]/g, "-");
      const body = snapshot.body!;
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
