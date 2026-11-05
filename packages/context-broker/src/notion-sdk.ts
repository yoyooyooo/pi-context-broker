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
  offline?: boolean;
  maxAge?: number;
};
type RuntimeOptions = Options & { metrics?: boolean; onRequestMetrics?: (snapshot: unknown) => void };
type Sdk = {
  SDK_VERSION: 1;
  CONSUMER_CONTRACT_VERSION: 1;
  PACKAGE_VERSION: string;
  consume: (input: unknown, options?: RuntimeOptions) => Promise<unknown>;
  decodeConsumeResult: (value: unknown, expected?: unknown) => Promise<unknown>;
  readSkill: (target: string, options?: RuntimeOptions) => Promise<unknown>;
  READ_OUTPUT_PROOF_VERSION?: number;
  RESOURCE_READ_CONTRACT_VERSION?: number;
  readResources?: (input: unknown, options?: RuntimeOptions) => Promise<unknown>;
  decodeResourceReadResult?: (value: unknown, expected?: unknown) => Promise<unknown>;
  parseDuration: (input: string) => number;
};
const observations = channel("context-broker.notion-sdk");
let bundledSdk: Promise<Sdk> | undefined;
let resourceContractVersion: unknown;
let readOutputProofVersion: unknown;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    return sdk;
  })();
  try { return await bundledSdk; }
  catch (error) { bundledSdk = undefined; throw error; }
}

/** Code is shared; every operation still creates and closes its own SDK runtime. */
async function observed(operation: "consume" | "read" | "read-resources", options: Options, run: (sdk: Sdk, options: RuntimeOptions) => Promise<unknown>): Promise<unknown> {
  const enabled = observations.hasSubscribers;
  const id = enabled ? randomUUID() : undefined;
  const started = process.hrtime.bigint();
  let sdkStarted = false;
  let metricsObserved = false;
  let metrics: unknown = null;
  let status = "failed";
  if (enabled) observations.publish({ version: 1, event: "start", id, operation, pid: process.pid, monotonic_ns: started.toString() });
  try {
    const sdk = await loadBundledSdk();
    if (operation === "read-resources" && (sdk.RESOURCE_READ_CONTRACT_VERSION !== 1 || resourceContractVersion !== 1
      || typeof sdk.readResources !== "function" || typeof sdk.decodeResourceReadResult !== "function")) throw new NotionSdkError("SOURCE_SDK_INCOMPATIBLE");
    sdkStarted = true;
    const value = await run(sdk, { ...options, ...(enabled ? { metrics: true, onRequestMetrics: (snapshot: unknown) => {
      metricsObserved = true;
      // The SDK's public metrics contract excludes headers, raw paths, bodies and signed URLs.
      metrics = snapshot;
    } } : {}) });
    status = object(value) && value.status === "cancelled" ? "cancelled" : object(value) && value.status === "failed" ? "failed" : "completed";
    return value;
  } catch (error) {
    if (options.signal?.aborted || object(error) && error.code === "CANCELLED") status = "cancelled";
    throw error;
  } finally {
    if (enabled) {
      const ended = process.hrtime.bigint();
      observations.publish({ version: 1, event: "end", id, operation, pid: process.pid, monotonic_ns: ended.toString(),
        elapsed_ms: Number(ended - started) / 1e6, status, sdk_started: sdkStarted, metrics_observed: metricsObserved, request_metrics: metrics });
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
