import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SourceMaterializationRequest } from "./source-materialization-contract";

export type SourceManagementOptions = {
  cwd: string; library: string; signal?: AbortSignal; env?: Readonly<Record<string, string | undefined>>;
};
type Management = {
  SOURCE_MATERIALIZATION_VERSION: 1; PACKAGE_VERSION: string;
  materializeSource(input: SourceMaterializationRequest, options: SourceManagementOptions): Promise<unknown>;
};
export class SourceManagementUnavailable extends Error {
  readonly code = "SOURCE_MANAGEMENT_UNAVAILABLE";
  constructor() { super("The paired Source management runtime is unavailable or incompatible"); }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function compatible(value: unknown): value is Management {
  return object(value) && value.SOURCE_MATERIALIZATION_VERSION === 1 && typeof value.PACKAGE_VERSION === "string"
    && value.PACKAGE_VERSION.length > 0 && typeof value.materializeSource === "function";
}
let selected: Promise<Management> | undefined;
async function loadManagement(): Promise<Management> {
  selected ??= (async () => {
    const adjacent = new URL("./ntn-skills-management.mjs", import.meta.url);
    const location = existsSync(fileURLToPath(adjacent)) ? adjacent : new URL("../dist/ntn-skills-management.mjs", import.meta.url);
    try {
      const bytes = await readFile(location);
      const manifest: unknown = JSON.parse(await readFile(new URL("./ntn-skills-runtime.json", location), "utf8"));
      if (!object(manifest) || manifest.version !== 1 || manifest.package !== "ntn-skills" || manifest.source_materialization_version !== 1
        || manifest.management_sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new SourceManagementUnavailable();
      const module: unknown = await import(location.href);
      if (!compatible(module) || module.PACKAGE_VERSION !== manifest.package_version) throw new SourceManagementUnavailable();
      return module;
    } catch { throw new SourceManagementUnavailable(); }
  })();
  try { return await selected; } catch (error) { selected = undefined; throw error; }
}

/** A separate management entry owns dispatch and durable recovery. Cancellation
 * abandons the foreground wait; the manager retains any accepted operation. */
export async function materializeNotionSource(input: SourceMaterializationRequest, options: SourceManagementOptions): Promise<unknown> {
  options.signal?.throwIfAborted();
  const management = await loadManagement();
  options.signal?.throwIfAborted();
  return management.materializeSource(input, options);
}
