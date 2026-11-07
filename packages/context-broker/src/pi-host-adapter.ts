import { dirname } from "node:path";
import type { HostCapabilities } from "./host-adapter";
import type { ExtensionAPI, ExtensionContext, PiReadDefinition, SkillRecord } from "./types";
import { installPiDollarAutocompleteEditor } from "./pi-dollar-editor";
import { DEFAULT_RESOURCE_READ_BUDGET, NOTION_RESOURCE_READ_TOOL } from "./resource-read-types";

const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
type PiReadFactory = (cwd: string, options?: { autoResizeImages?: boolean }) => PiReadDefinition;
type ReadFactoryLoader = () => Promise<PiReadFactory | undefined>;
async function loadPiReadFactory(): Promise<PiReadFactory | undefined> {
  try { return (await import(PI_PACKAGE_NAME) as { createReadToolDefinition?: PiReadFactory }).createReadToolDefinition; }
  catch { return undefined; }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const resourceRef = /^(?:sr:R[A-Za-z0-9_-]{22}|skill:\/\/.+)$/;
const resourcePathsSchema = () => ({ type: "array", minItems: 1, maxItems: DEFAULT_RESOURCE_READ_BUDGET.maxFiles,
  items: { type: "string", pattern: resourceRef.source },
  description: "Copy complete resource refs verbatim from the selected Skill snapshot's resource directory. Every ref must identify a file in the same owner and snapshot. Reads all selected files in one operation without preparing the main body." });
const validResourcePaths = (input: Record<string, unknown>) => Object.keys(input).every(key => key === "paths") && Array.isArray(input.paths)
  && input.paths.length >= 1 && input.paths.length <= DEFAULT_RESOURCE_READ_BUDGET.maxFiles
  && input.paths.every(value => typeof value === "string" && resourceRef.test(value));
const resourceReadUnavailable = () => Object.assign(new Error("Notion resource batch reading is unavailable"), { code: "SOURCE_RESOURCE_BATCH_UNAVAILABLE" });
const resourceOutputSchema = {
  type: "object", properties: {
    status: { const: "ready" }, files: { type: "array", items: { anyOf: [
      { type: "object", properties: { kind: { const: "text" }, ref: { type: "string" }, path: { type: "string" }, content: { type: "string" } },
        required: ["kind", "ref", "path", "content"], additionalProperties: false },
      { type: "object", properties: { kind: { const: "binary" }, ref: { type: "string" }, path: { type: "string" }, bytes: { type: "integer", minimum: 0 }, sha256: { type: "string" }, output: { type: "string" } },
        required: ["kind", "ref", "path", "bytes", "sha256", "output"], additionalProperties: false },
    ] } },
  }, required: ["status", "files"], additionalProperties: false,
};

export function createPiHostAdapter(api: ExtensionAPI, loadReadFactory: ReadFactoryLoader = loadPiReadFactory): HostCapabilities {
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
    registerReadExecutor(execute) {
      const register = api.registerTool, allTools = api.getAllTools, activeTools = api.getActiveTools;
      if (!register || !allTools || !activeTools) return undefined;
      let installedParameters: Record<string, unknown> | undefined;
      let resourceParameters: Record<string, unknown> | undefined, suspendedResources = false;
      const ownsRead = () => installedParameters !== undefined && allTools().some(tool => tool.name === "read" && tool.parameters === installedParameters);
      const ownsResources = () => resourceParameters !== undefined && allTools().some(tool => tool.name === NOTION_RESOURCE_READ_TOOL && tool.parameters === resourceParameters);
      const syncResources = () => {
        // A third-party reader keeps its implementation and rendering. Expose
        // only our independent batch route when it cannot use the read wrapper.
        const active = activeTools(), needed = active.includes("read") && allTools().some(tool => tool.name === "read") && !ownsRead();
        if (!resourceParameters) {
          if (!needed || !api.setActiveTools || allTools().some(tool => tool.name === NOTION_RESOURCE_READ_TOOL)) return;
          const parameters = { type: "object", properties: { paths: resourcePathsSchema() }, required: ["paths"], additionalProperties: false };
          register({ name: NOTION_RESOURCE_READ_TOOL, label: "Read Notion resources",
            description: "Read selected supporting files from one fixed Notion Skill snapshot in one operation. Copy their supplied resource refs into paths. This cannot read a main entry, load Requires or activate a workflow; use read for a main entry or a single file.",
            parameters, outputSchema: resourceOutputSchema, strict: true, readsSkillUris: true, loadMode: "essential",
            sourcePath: import.meta.url, defaultInactive: false, defaultActive: true, approval: () => "read", approvalCacheTargets: () => undefined,
            async execute(id, input, signal, _onUpdate, context) {
              if (!ownsResources() || ownsRead() || !activeTools().includes("read") || !activeTools().includes(NOTION_RESOURCE_READ_TOOL)) throw resourceReadUnavailable();
              if (!validResourcePaths(input)) throw Object.assign(new Error("Choose fixed resource refs in paths"), { code: "INVALID_ARGUMENT" });
              return execute(input, context, signal, async () => { throw resourceReadUnavailable(); }, id);
            },
          });
          resourceParameters = parameters;
          return;
        }
        if (!ownsResources() || !api.setActiveTools) return;
        if (!needed && active.includes(NOTION_RESOURCE_READ_TOOL)) {
          api.setActiveTools(active.filter(name => name !== NOTION_RESOURCE_READ_TOOL));
          suspendedResources = true;
        } else if (needed && suspendedResources) {
          // Restore only a capability we suspended. A tool the user explicitly
          // disabled while read stayed available remains disabled.
          if (!active.includes(NOTION_RESOURCE_READ_TOOL)) api.setActiveTools([...active, NOTION_RESOURCE_READ_TOOL]);
          suspendedResources = false;
        }
      };
      const installRead = async (ctx: ExtensionContext) => {
        if (installedParameters) return;
        const original = allTools().find(tool => tool.name === "read");
        if (original?.sourceInfo.source !== "builtin") return;
        const createRead = await loadReadFactory();
        if (!createRead || allTools().find(tool => tool.name === "read")?.parameters !== original.parameters) return;
        const native = createRead(ctx.cwd ?? process.cwd(), { autoResizeImages: api.getSettings?.().images?.autoResize ?? true });
        if (!object(native.parameters) || !object(native.parameters.properties) || typeof native.execute !== "function") return;
        const scalarProperties = { ...native.parameters.properties, path: {
          ...(object(native.parameters.properties.path) ? native.parameters.properties.path : { type: "string" }),
          description: "Local file path (relative or absolute), or an issued skill:// or sr: ref. Copy refs verbatim; never guess filesystem paths.",
        } };
        // Providers may reject root combinators. Enforce the two exclusive modes
        // before shared preparation or native I/O, including direct tool callers.
        const parameters: Record<string, unknown> = { type: "object", properties: { ...scalarProperties, paths: resourcePathsSchema() } };
        const definition: PiReadDefinition = {
          ...native,
          description: "For Notion introductions, summaries or inspection, copy a supplied Skill/resource ref into path. This reads content without loading Requires or activating its workflow. " + native.description + " Alternatively, paths reads fixed resources of one owner and snapshot together; choose path or paths. Batch reads exclude offset/limit and the main entrypoint.",
          parameters, defaultActive: activeTools().includes("read"),
          ...(native.outputSchema ? { outputSchema: { anyOf: [native.outputSchema, resourceOutputSchema] } } : {}),
          async execute(id, input, signal, onUpdate, context) {
            const hasPath = Object.hasOwn(input, "path"), hasPaths = Object.hasOwn(input, "paths");
            if (hasPath === hasPaths
              || hasPath && (typeof input.path !== "string" || [input.offset, input.limit].some(value => value !== undefined && (typeof value !== "number" || !Number.isFinite(value))))
              || hasPaths && !validResourcePaths(input)) {
              throw Object.assign(new Error("Choose one file path or an explicit resource paths array"), { code: "INVALID_ARGUMENT" });
            }
            return execute(input, context, signal,
              (updated, preparedSignal) => native.execute(id, updated, preparedSignal ?? signal, onUpdate, context), id);
          },
          ...(native.renderCall ? { renderCall: (input, theme, context) => native.renderCall!(
            Array.isArray(input.paths) ? { path: input.paths.join(", ") } : input, theme, context) } : {}),
        };
        register(definition);
        installedParameters = parameters;
      };
      api.on("session_start", async (_event, ctx) => { await installRead(ctx); syncResources(); });
      api.on("before_agent_start", () => { syncResources(); return undefined; });
      api.on("context", () => { syncResources(); return undefined; });
      // Pi retains the public schema object in getAllTools. This identity also
      // detects a later override without relying on the bundled source pathname.
      return ownsRead;
    },
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
