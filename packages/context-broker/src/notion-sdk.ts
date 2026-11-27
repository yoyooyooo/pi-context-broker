import { channel } from "node:diagnostics_channel";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ContentSearchRequest } from "./content-search";
import type { AuthorizationPresentation } from "./pi-authorization";
const canonicalUuid = (value: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

export type SharedLibrary = {
  version: 2;
  library_id: string;
  operation_id: string;
  skills: TableBinding;
  files: TableBinding;
  records: TableBinding;
  sources: TableBinding;
};
type TableBinding = { database_id: string; data_source_id: string; property_ids: Record<string, string> };

/** This boundary loads only the SDK bundled beside the selected ntn-skills CLI. */
export class NotionSdkError extends Error {
  constructor(readonly code: "SOURCE_SDK_UNAVAILABLE" | "SOURCE_SDK_INCOMPATIBLE") {
    super(`Bundled Notion SDK is unavailable or incompatible (${code})`);
    this.name = "NotionSdkError";
  }
}

type Options = {
  /** Broker observation identity; stripped before invoking the SDK. */
  sourceId?: string;
  library?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  deadline?: number;
  onAuthorize?: (request: AuthorizationPresentation) => Promise<void>;
  execution?: { priority?: "required" | "prefetch"; queueBudgetMs?: number; timeBudgetMs?: number; rateShare?: number };
  path?: string;
  from?: string;
  lines?: string;
  output?: string;
  refresh?: boolean;
  offline?: boolean;
  maxAge?: number;
  view?: string;
  defaultView?: boolean;
  profile?: string;
  directory?: { view?: string; profile?: string };
  onCatalogSettled?: () => void;
};
export type SourceMemberDiscoveryInput = { library: string } & ({
  query?: string; source_id?: string; requires_of?: never;
} | { requires_of: string; query?: never; source_id?: never });
type RuntimeOptions = Omit<Options, "sourceId"> & { metrics?: boolean; onRequestMetrics?: (snapshot: unknown) => void };
type Sdk = {
  SKILL_REF_VERSION: 2;
  SDK_VERSION: 3;
  CONSUMER_CONTRACT_VERSION: 1;
  PACKAGE_VERSION: string;
  selectLibrary: (options?: RuntimeOptions) => Promise<string>;
  resolveLibrary: (options?: RuntimeOptions) => Promise<SharedLibrary>;
  consume: (input: unknown, options?: RuntimeOptions) => Promise<unknown>;
  decodeConsumeResult: (value: unknown, expected?: unknown) => Promise<unknown>;
  readSkill: (target: string, options?: RuntimeOptions) => Promise<unknown>;
  listCatalog?: (options?: RuntimeOptions) => Promise<unknown>;
  readCandidateSnapshot?: (options?: RuntimeOptions) => Promise<unknown>;
  CANDIDATE_SNAPSHOT_CONTRACT_VERSION?: number;
  SOURCE_MATERIALIZATION_VERSION?: number;
  discoverSourceMembers?: (input: SourceMemberDiscoveryInput, options?: RuntimeOptions) => Promise<unknown>;
  resolveCatalogReference?: (target: string, catalog: unknown) => unknown;
  resolveReference?: (target: string, options: RuntimeOptions & { from: string }) => Promise<unknown>;
  listSkill?: (target: string, options?: RuntimeOptions) => Promise<unknown>;
  contentSearch?: (input: ContentSearchRequest, options?: RuntimeOptions) => Promise<unknown>;
  CONTENT_SEARCH_CONTRACT_VERSION?: number;
  READ_OUTPUT_PROOF_VERSION?: number;
  CATALOG_DIRECTORY_CONTRACT_VERSION?: number;
  RESOURCE_READ_CONTRACT_VERSION?: number;
  RESOURCE_READ_EFFECTS_VERSION?: number;
  CONSUMPTION_EFFECTS_VERSION?: number;
  readResources?: (input: unknown, options?: RuntimeOptions) => Promise<unknown>;
  decodeResourceReadResult?: (value: unknown, expected?: unknown) => Promise<unknown>;
  parseDuration: (input: string) => number;
};
const observations = channel("context-broker.notion-sdk");
// Private verification observers opt in to raw results; normal metrics never contain source bodies.
const resultObservations = channel("context-broker.notion-sdk-result");
let bundledSdk: Promise<Sdk> | undefined;
let resourceContractVersion: unknown;
let readOutputProofVersion: unknown;
let catalogDirectoryContractVersion: unknown;
let consumptionEffectsVersion: unknown;
let resourceEffectsVersion: unknown;
let contentSearchContractVersion: unknown;
let candidateSnapshotContractVersion: unknown;
let sourceMaterializationVersion: unknown;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function observationErrorCode(error: unknown): string | null {
  return object(error) && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : null;
}
function compatible(value: unknown): value is Sdk {
  return object(value) && value.SKILL_REF_VERSION === 2 && value.SDK_VERSION === 3 && value.CONSUMER_CONTRACT_VERSION === 1
    && typeof value.PACKAGE_VERSION === "string" && value.PACKAGE_VERSION.length > 0
    && typeof value.selectLibrary === "function" && typeof value.resolveLibrary === "function" && typeof value.consume === "function" && typeof value.decodeConsumeResult === "function" && typeof value.readSkill === "function" && typeof value.parseDuration === "function";
}
async function loadBundledSdk(): Promise<Sdk> {
  bundledSdk ??= (async () => {
    const adjacent = new URL("./ntn-skills-sdk.mjs", import.meta.url);
    const location = existsSync(fileURLToPath(adjacent)) ? adjacent : new URL("../dist/ntn-skills-sdk.mjs", import.meta.url);
    if (!existsSync(fileURLToPath(location))) throw new NotionSdkError("SOURCE_SDK_UNAVAILABLE");
    let sdk: unknown;
    try { sdk = await import(location.href); }
    catch { throw new NotionSdkError("SOURCE_SDK_UNAVAILABLE"); }
    if (!compatible(sdk)) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    let manifest: unknown;
    try { manifest = JSON.parse(await readFile(new URL("./ntn-skills-runtime.json", location), "utf8")); }
    catch { throw new NotionSdkError("SOURCE_SDK_UNAVAILABLE"); }
    if (!object(manifest) || manifest.version !== 1 || manifest.skill_ref_version !== 2 || manifest.package !== "ntn-skills" || manifest.package_version !== sdk.PACKAGE_VERSION
      || manifest.sdk_version !== sdk.SDK_VERSION || manifest.consumer_contract_version !== sdk.CONSUMER_CONTRACT_VERSION) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    resourceContractVersion = manifest.resource_read_contract_version;
    readOutputProofVersion = manifest.read_output_proof_version;
    catalogDirectoryContractVersion = manifest.catalog_directory_contract_version;
    consumptionEffectsVersion = manifest.consumption_effects_version;
    resourceEffectsVersion = manifest.resource_read_effects_version;
    contentSearchContractVersion = manifest.content_search_contract_version;
    candidateSnapshotContractVersion = manifest.candidate_snapshot_contract_version;
    sourceMaterializationVersion = manifest.source_materialization_version;
    return sdk;
  })();
  try { return await bundledSdk; }
  catch (error) { bundledSdk = undefined; throw error; }
}

/** Code is shared; every operation still creates and closes its own SDK runtime. */
async function observed(operation: "library-selection" | "library" | "consume" | "read" | "read-resources" | "list" | "candidates" | "files" | "resolve" | "content-search" | "source-members", options: Options, run: (sdk: Sdk, options: RuntimeOptions) => Promise<unknown>): Promise<unknown> {
  const { sourceId, ...runtimeOptions } = options;
  const attribution = { source_id: sourceId ?? null, library: options.library ?? null };
  const enabled = observations.hasSubscribers;
  const id = enabled || resultObservations.hasSubscribers ? randomUUID() : undefined;
  const started = process.hrtime.bigint();
  let sdkStarted = false;
  let metricsObserved = false;
  let metrics: unknown = null;
  let status = "failed";
  let errorCode: string | null = null;
  if (enabled) observations.publish({ version: 1, event: "start", id, operation, ...attribution, pid: process.pid, monotonic_ns: started.toString() });
  try {
    const sdk = await loadBundledSdk();
    if (sdk.CONSUMPTION_EFFECTS_VERSION !== 1 || consumptionEffectsVersion !== 1) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "read-resources"
      && (sdk.RESOURCE_READ_EFFECTS_VERSION !== 1 || resourceEffectsVersion !== 1)) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "list" && typeof sdk.listCatalog !== "function") throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if ((operation === "candidates" || operation === "list" && options.onCatalogSettled !== undefined)
      && (sdk.CANDIDATE_SNAPSHOT_CONTRACT_VERSION !== 1 || candidateSnapshotContractVersion !== 1
      || typeof sdk.readCandidateSnapshot !== "function")) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "list" && options.directory !== undefined
      && (sdk.CATALOG_DIRECTORY_CONTRACT_VERSION !== 1 || catalogDirectoryContractVersion !== 1)) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "read" && options.output !== undefined
      && (sdk.READ_OUTPUT_PROOF_VERSION !== 1 || readOutputProofVersion !== 1)) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "files" && typeof sdk.listSkill !== "function") throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "resolve" && typeof sdk.resolveReference !== "function") throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "content-search" && (sdk.CONTENT_SEARCH_CONTRACT_VERSION !== 1 || contentSearchContractVersion !== 1
      || typeof sdk.contentSearch !== "function")) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "read-resources" && (sdk.RESOURCE_READ_CONTRACT_VERSION !== 1 || resourceContractVersion !== 1
      || typeof sdk.readResources !== "function" || typeof sdk.decodeResourceReadResult !== "function")) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    sdkStarted = true;
    const value = await run(sdk, { ...runtimeOptions, ...(enabled ? { metrics: true, onRequestMetrics: (snapshot: unknown) => {
      metricsObserved = true;
      // The SDK's public metrics contract excludes headers, raw paths, bodies and signed URLs.
      metrics = snapshot;
    } } : {}) });
    status = object(value) && value.status === "cancelled" ? "cancelled" : object(value) && value.status === "failed" ? "failed" : "completed";
    if (status === "failed" && object(value)) errorCode = observationErrorCode(value.error);
    if (resultObservations.hasSubscribers) resultObservations.publish({ version: 1, id, operation, value });
    return value;
  } catch (error) {
    errorCode = observationErrorCode(error);
    if (options.signal?.aborted || object(error) && error.code === "CANCELLED") status = "cancelled";
    throw error;
  } finally {
    if (enabled) {
      const ended = process.hrtime.bigint();
      observations.publish({ version: 1, event: "end", id, operation, ...attribution, pid: process.pid, monotonic_ns: ended.toString(),
        elapsed_ms: Number(ended - started) / 1e6, status, error_code: errorCode, sdk_started: sdkStarted, metrics_observed: metricsObserved, request_metrics: metrics });
    }
  }
}

export function consumeNotionSdk(input: unknown, options: Options): Promise<unknown> {
  // consume returns the public decoder's verified result. Re-running that same
  // decoder would hash the whole graph twice without adding an identity check.
  return observed("consume", options, (sdk, runtime) => sdk.consume(input, runtime));
}
/** Resolve the explicit/default root from local config without Notion I/O. */
export async function selectNotionLibrarySdk(options: Options): Promise<string> {
  const value = await observed("library-selection", options, (sdk, runtime) => sdk.selectLibrary(runtime));
  if (typeof value !== "string" || !canonicalUuid(value)) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
  return value;
}
/** Core alone verifies the root, descriptor and four tables, including empty libraries. */
export async function resolveNotionLibrarySdk(options: Options): Promise<SharedLibrary> {
  const value = await observed("library", options, (sdk, runtime) => sdk.resolveLibrary(runtime));
  if (!object(value) || value.version !== 2 || typeof value.library_id !== "string"
    || !canonicalUuid(value.library_id) || typeof value.operation_id !== "string")
    throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
  function table(value: unknown): value is TableBinding {
    return object(value) && typeof value.database_id === "string" && canonicalUuid(value.database_id)
      && typeof value.data_source_id === "string" && canonicalUuid(value.data_source_id)
      && object(value.property_ids) && Object.values(value.property_ids).every(id => typeof id === "string");
  }
  if (!table(value.skills) || !table(value.files) || !table(value.records) || !table(value.sources))
    throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
  return { version: 2, library_id: value.library_id, operation_id: value.operation_id,
    skills: value.skills, files: value.files, records: value.records, sources: value.sources };
}
export function readNotionSdk(target: string, options: Options): Promise<unknown> {
  return observed("read", options, (sdk, runtime) => sdk.readSkill(target, runtime));
}
/** The bundled core owns MCP transport, grants and fresh REST admission. */
export function searchNotionContentSdk(input: ContentSearchRequest, options: Options): Promise<unknown> {
  return observed("content-search", options, (sdk, runtime) => sdk.contentSearch!(input, runtime));
}
/** Resolve only; the host selects the target's own session version before reading. */
export function resolveNotionReferenceSdk(target: string, options: Options & { from: string }): Promise<unknown> {
  return observed("resolve", options, (sdk, runtime) => sdk.resolveReference!(target, { ...runtime, from: options.from }));
}
/** Metadata uses the core catalog cache; no CLI subprocess or second discovery authority. */
export function listNotionCatalogSdk(options: Options): Promise<unknown> {
  return observed("list", options, (sdk, runtime) => sdk.listCatalog!(runtime));
}
/** Pure local discovery. Unlike offline inspection, known refusals remain excluded. */
export function readNotionCandidateSnapshotSdk(options: Options): Promise<unknown> {
  return observed("candidates", options, (sdk, runtime) => sdk.readCandidateSnapshot!(runtime));
}
/** The shared resolver is pure; it never acquires another SDK runtime or source. */
export async function resolveNotionCatalogReferenceSdk(target: string, catalog: unknown): Promise<unknown> {
  const sdk = await loadBundledSdk();
  if (typeof sdk.resolveCatalogReference !== "function") throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
  return sdk.resolveCatalogReference(target, catalog);
}
/** Fixed names are owned by their retained manifest, without preparing its body. */
export function listNotionFilesSdk(target: string, options: Options): Promise<unknown> {
  return observed("files", options, (sdk, runtime) => sdk.listSkill!(target, runtime));
}
export function readNotionResourcesSdk(input: unknown, options: Options): Promise<unknown> {
  // The current SDK has already decoded and verified the complete result.
  return observed("read-resources", options, (sdk, runtime) => sdk.readResources!(input, runtime));
}
export async function parseNotionSdkDuration(input: string): Promise<number> {
  return (await loadBundledSdk()).parseDuration(input);
}

/** Registered Source discovery is metadata-only and cannot perform management. */
export async function discoverNotionSourceMembersSdk(input: SourceMemberDiscoveryInput, options: Options): Promise<unknown> {
  return observed("source-members", options, (sdk, runtimeOptions) => {
    if (sdk.SOURCE_MATERIALIZATION_VERSION !== 1 || sourceMaterializationVersion !== 1 || !sdk.discoverSourceMembers)
      throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    return sdk.discoverSourceMembers(input, runtimeOptions);
  });
}
