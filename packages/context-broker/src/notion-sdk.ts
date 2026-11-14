import { channel } from "node:diagnostics_channel";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
  database?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  execution?: { priority?: "required" | "prefetch"; queueBudgetMs?: number; timeBudgetMs?: number; rateShare?: number };
  path?: string;
  from?: string;
  lines?: string;
  output?: string;
  refresh?: boolean;
  readOnly?: boolean;
  offline?: boolean;
  maxAge?: number;
  view?: string;
  defaultView?: boolean;
  profile?: string;
  directory?: { view?: string; profile?: string };
};
type RuntimeOptions = Omit<Options, "sourceId"> & { metrics?: boolean; onRequestMetrics?: (snapshot: unknown) => void };
type Sdk = {
  SDK_VERSION: 1;
  CONSUMER_CONTRACT_VERSION: 1;
  PACKAGE_VERSION: string;
  consume: (input: unknown, options?: RuntimeOptions) => Promise<unknown>;
  decodeConsumeResult: (value: unknown, expected?: unknown) => Promise<unknown>;
  readSkill: (target: string, options?: RuntimeOptions) => Promise<unknown>;
  listCatalog?: (options?: RuntimeOptions) => Promise<unknown>;
  resolveCatalogReference?: (target: string, catalog: unknown) => unknown;
  listSkill?: (target: string, options?: RuntimeOptions) => Promise<unknown>;
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

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function observationErrorCode(error: unknown): string | null {
  return object(error) && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) ? error.code : null;
}
function compatible(value: unknown): value is Sdk {
  return object(value) && value.SDK_VERSION === 1 && value.CONSUMER_CONTRACT_VERSION === 1
    && typeof value.PACKAGE_VERSION === "string" && value.PACKAGE_VERSION.length > 0
    && typeof value.consume === "function" && typeof value.decodeConsumeResult === "function" && typeof value.readSkill === "function" && typeof value.parseDuration === "function";
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
    if (!object(manifest) || manifest.version !== 1 || manifest.package !== "ntn-skills" || manifest.package_version !== sdk.PACKAGE_VERSION
      || manifest.sdk_version !== sdk.SDK_VERSION || manifest.consumer_contract_version !== sdk.CONSUMER_CONTRACT_VERSION) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    resourceContractVersion = manifest.resource_read_contract_version;
    readOutputProofVersion = manifest.read_output_proof_version;
    catalogDirectoryContractVersion = manifest.catalog_directory_contract_version;
    consumptionEffectsVersion = manifest.consumption_effects_version;
    resourceEffectsVersion = manifest.resource_read_effects_version;
    return sdk;
  })();
  try { return await bundledSdk; }
  catch (error) { bundledSdk = undefined; throw error; }
}

/** Code is shared; every operation still creates and closes its own SDK runtime. */
async function observed(operation: "consume" | "read" | "read-resources" | "list" | "files", options: Options, run: (sdk: Sdk, options: RuntimeOptions) => Promise<unknown>): Promise<unknown> {
  const { sourceId, ...runtimeOptions } = options;
  const attribution = { source_id: sourceId ?? null, database: options.database ?? null };
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
    if (options.readOnly && (sdk.CONSUMPTION_EFFECTS_VERSION !== 1 || consumptionEffectsVersion !== 1)) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (options.readOnly && operation === "read-resources"
      && (sdk.RESOURCE_READ_EFFECTS_VERSION !== 1 || resourceEffectsVersion !== 1)) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "list" && typeof sdk.listCatalog !== "function") throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "list" && options.directory !== undefined
      && (sdk.CATALOG_DIRECTORY_CONTRACT_VERSION !== 1 || catalogDirectoryContractVersion !== 1)) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    if (operation === "files" && typeof sdk.listSkill !== "function") throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
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
export function readNotionSdk(target: string, options: Options): Promise<unknown> {
  return observed("read", options, (sdk, runtime) => sdk.readSkill(target, runtime));
}
/** Metadata uses the core catalog cache; no CLI subprocess or second discovery authority. */
export function listNotionCatalogSdk(options: Options): Promise<unknown> {
  return observed("list", options, (sdk, runtime) => sdk.listCatalog!(runtime));
}
/** A paired directory shares only this SDK operation's metadata observation. */
export async function supportsNotionSdkCatalogDirectory(): Promise<boolean> {
  const sdk = await loadBundledSdk();
  if (sdk.CATALOG_DIRECTORY_CONTRACT_VERSION === undefined && catalogDirectoryContractVersion === undefined) return false;
  if (sdk.CATALOG_DIRECTORY_CONTRACT_VERSION !== 1 || catalogDirectoryContractVersion !== 1) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
  return true;
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
/** Feature detection loads code only; an older SDK never starts a speculative read. */
export async function supportsNotionSdkReadOutputProof(): Promise<boolean> {
  const sdk = await loadBundledSdk();
  if (sdk.READ_OUTPUT_PROOF_VERSION === undefined && readOutputProofVersion === undefined) return false;
  if (sdk.READ_OUTPUT_PROOF_VERSION !== 1 || readOutputProofVersion !== 1) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
  return true;
}
export function readNotionResourcesSdk(input: unknown, options: Options): Promise<unknown> {
  // This additive capability is checked only when used. The SDK has already
  // decoded and verified the full result; older SDKs still support scalar read.
  return observed("read-resources", options, (sdk, runtime) => sdk.readResources!(input, runtime));
}
export async function parseNotionSdkDuration(input: string): Promise<number> {
  return (await loadBundledSdk()).parseDuration(input);
}
