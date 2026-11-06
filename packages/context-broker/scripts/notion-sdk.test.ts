import { test, expect } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { channel } from "node:diagnostics_channel";

// These fixtures exercise the loading/observation boundary only. Actual SDK
// runtime, package and Pi proofs use independently installed ntn-skills builds.
async function fixture(options: { sdk?: boolean; sdkVersion?: number; packageVersion?: string; manifestVersion?: string; resourceVersion?: number; resourceManifestVersion?: number; readProofVersion?: number; readProofManifestVersion?: number; catalog?: boolean; catalogFailure?: "typed" | "returned" | "untyped" | "unsafe"; resolver?: boolean; files?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "broker-sdk-boundary-"));
  await mkdir(join(root, "src")); await mkdir(join(root, "dist"));
  await copyFile(new URL("../src/notion-sdk.ts", import.meta.url), join(root, "src/notion-sdk.ts"));
  const module = join(root, "dist/ntn-skills-sdk.mjs");
  if (options.sdk !== false) await writeFile(module, `
export const SDK_VERSION = ${options.sdkVersion ?? 1};
export const CONSUMER_CONTRACT_VERSION = 1;
export const PACKAGE_VERSION = ${JSON.stringify(options.packageVersion ?? "fixture-1")};
${options.readProofVersion === undefined ? "" : `export const READ_OUTPUT_PROOF_VERSION = ${options.readProofVersion};`}
export const calls = [];
export function parseDuration(value) { return value === '1s' ? 1000 : 0; }
export function decodeConsumeResult() { throw new Error('consume already decoded; duplicate decoder invocation'); }
export async function consume(input, options) {
  calls.push({ input, options });
  await new Promise(resolve => setTimeout(resolve, 10));
  options.onRequestMetrics?.(null);
  return { status: options.signal?.aborted ? 'cancelled' : 'ready', input, cwd: options.cwd, identity: options.env?.SDK_TEST_ID };
}
export async function readSkill(target, options) {
  calls.push({ target, options });
  options.onRequestMetrics?.({ total_requests: 0, trace: [] });
  return { target, output: options.output };
}
${options.catalog ? `
export const catalogError = Object.assign(new Error('PRIVATE_ERROR_MESSAGE_SENTINEL'), {
  code: ${options.catalogFailure === "untyped" ? "undefined" : JSON.stringify(options.catalogFailure === "unsafe" ? "A".repeat(129) : "CACHE_MISSING")},
  details: { private: 'PRIVATE_ERROR_DETAILS_SENTINEL' },
});
export async function listCatalog(options) {
  calls.push({ operation: 'list', options });
  options.onRequestMetrics?.({ total_requests: 0, trace: [] });
  ${options.catalogFailure === "returned" ? "return { status: 'failed', error: catalogError };" : options.catalogFailure ? "throw catalogError;" : ""}
  return { records: [], count: 0, view: options.view, scope: options.env?.SDK_TEST_ID };
}
` : ""}
${options.resolver ? `
export function resolveCatalogReference(target, catalog) {
  return { target, record: catalog.records[0], scope: catalog.scope, ref: catalog.records[0].ref };
}
` : ""}
${options.files ? `
export async function listSkill(target, options) {
  calls.push({ operation: 'files', target, options });
  options.onRequestMetrics?.({ total_requests: 0, trace: [] });
  return { target, files: [], scope: options.env?.SDK_TEST_ID };
}
` : ""}
${options.resourceVersion === undefined ? "" : `
export const RESOURCE_READ_CONTRACT_VERSION = ${options.resourceVersion};
export function decodeResourceReadResult() { throw new Error('resource read already decoded'); }
export async function readResources(input, options) {
  calls.push({ operation: 'read-resources', input, options });
  options.onRequestMetrics?.({ total_requests: 0, trace: [] });
  return { version: 1, status: 'ready', input };
}
`}
`);
  await writeFile(join(root, "dist/ntn-skills-runtime.json"), JSON.stringify({ version: 1, package: "ntn-skills",
    package_version: options.manifestVersion ?? options.packageVersion ?? "fixture-1", sdk_version: 1, consumer_contract_version: 1,
    ...(options.resourceVersion === undefined ? {} : { resource_read_contract_version: options.resourceManifestVersion ?? options.resourceVersion }),
    ...(options.readProofVersion === undefined && options.readProofManifestVersion === undefined ? {} : { read_output_proof_version: options.readProofManifestVersion ?? options.readProofVersion }) }));
  const boundary = await import(pathToFileURL(join(root, "src/notion-sdk.ts")).href);
  return { root, boundary, module };
}

test("missing bundled SDK fails without selecting another CLI or SDK", async () => {
  const { boundary } = await fixture({ sdk: false });
  await expect(boundary.consumeNotionSdk({}, {})).rejects.toMatchObject({ code: "SOURCE_SDK_UNAVAILABLE" });
});

test("unsupported SDK protocol stops before its consume function", async () => {
  const { boundary, module } = await fixture({ sdkVersion: 2 });
  await expect(boundary.consumeNotionSdk({}, {})).rejects.toMatchObject({ code: "SOURCE_SDK_INCOMPATIBLE" });
  expect((await import(pathToFileURL(module).href)).calls).toHaveLength(0);
});

test("a different SDK package version cannot satisfy the bundled CLI manifest", async () => {
  const { boundary, module } = await fixture({ packageVersion: "fixture-2", manifestVersion: "fixture-1" });
  await expect(boundary.consumeNotionSdk({}, {})).rejects.toMatchObject({ code: "SOURCE_SDK_INCOMPATIBLE" });
  expect((await import(pathToFileURL(module).href)).calls).toHaveLength(0);
});

test("concurrent calls keep caller cwd, captured environment and cancellation separate", async () => {
  const { boundary, module } = await fixture();
  const first = new AbortController(), second = new AbortController();
  const jobs = [boundary.consumeNotionSdk({ roots: ["A"] }, { cwd: "/fixture/a", env: { SDK_TEST_ID: "A" }, signal: first.signal }),
    boundary.consumeNotionSdk({ roots: ["B"] }, { cwd: "/fixture/b", env: { SDK_TEST_ID: "B" }, signal: second.signal })];
  first.abort();
  const [a, b] = await Promise.all(jobs);
  expect(a).toMatchObject({ status: "cancelled", cwd: "/fixture/a", identity: "A" });
  expect(b).toMatchObject({ status: "ready", cwd: "/fixture/b", identity: "B" });
  expect((await import(pathToFileURL(module).href)).calls).toHaveLength(2);
});

test("passive metrics distinguish unobserved initialization from a measured zero", async () => {
  const { boundary } = await fixture();
  const observations: unknown[] = [];
  const topic = channel("context-broker.notion-sdk");
  const collect = (value: unknown) => observations.push(value);
  topic.subscribe(collect);
  try {
    await boundary.consumeNotionSdk({ private_body: "PRIVATE_INPUT_SENTINEL" }, { env: { PRIVATE_TOKEN: "PRIVATE_TOKEN_SENTINEL" } });
    await boundary.readNotionSdk("PRIVATE_TARGET_SENTINEL", { output: "/private/output" });
  } finally { topic.unsubscribe(collect); }
  const end = observations.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null && "event" in value && value.event === "end");
  expect(end).toHaveLength(2);
  expect(end[0]).toMatchObject({ operation: "consume", status: "completed", sdk_started: true, metrics_observed: true, request_metrics: null });
  expect(end[1]).toMatchObject({ operation: "read", status: "completed", sdk_started: true, metrics_observed: true, request_metrics: { total_requests: 0, trace: [] } });
  const text = JSON.stringify(observations);
  for (const secret of ["PRIVATE_INPUT_SENTINEL", "PRIVATE_TOKEN_SENTINEL", "PRIVATE_TARGET_SENTINEL", "/private/output"]) expect(text).not.toContain(secret);
  expect(end.every(value => typeof value.elapsed_ms === "number" && value.elapsed_ms >= 0)).toBe(true);
});

test("the shared public duration parser is used without acquiring an operation runtime", async () => {
  const { boundary, module, root } = await fixture();
  expect(await boundary.parseNotionSdkDuration("1s")).toBe(1000);
  expect((await import(pathToFileURL(module).href)).calls).toHaveLength(0);
  expect(JSON.parse(await readFile(join(root, "dist/ntn-skills-runtime.json"), "utf8")).package).toBe("ntn-skills");
});

test("passive SDK attribution binds concurrent source identities without changing runtime options", async () => {
  const healthy = await fixture({ catalog: true }), denied = await fixture({ catalog: true, catalogFailure: "typed" });
  const topic = channel("context-broker.notion-sdk"), events: unknown[] = [];
  const collect = (event: unknown) => events.push(event);
  const options = [
    { sourceId: "healthy-source", database: "healthy-database", env: { PRIVATE_TOKEN: "PRIVATE_TOKEN_SENTINEL" } },
    { sourceId: "denied-source", database: "denied-database", env: { PRIVATE_TOKEN: "PRIVATE_TOKEN_SENTINEL" } },
  ];
  topic.subscribe(collect);
  let outcomes: PromiseSettledResult<unknown>[];
  try { outcomes = await Promise.allSettled([healthy.boundary.listNotionCatalogSdk(options[0]), denied.boundary.listNotionCatalogSdk(options[1])]); }
  finally { topic.unsubscribe(collect); }
  expect(outcomes[0]?.status).toBe("fulfilled");
  const rejected = outcomes[1];
  if (!rejected || rejected.status !== "rejected") throw new Error("Expected the actual SDK rejection");
  expect(rejected.reason).toBe((await import(pathToFileURL(denied.module).href)).catalogError);
  const rows = events.filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null);
  expect(rows).toHaveLength(4);
  for (const [index, value] of options.entries()) {
    const starts = rows.filter(event => event.event === "start" && event.source_id === value.sourceId);
    expect(starts).toHaveLength(1);
    const start = starts[0];
    if (!start) throw new Error("Missing actual SDK start");
    expect(start).toMatchObject({ operation: "list", source_id: value.sourceId, database: value.database });
    const ends = rows.filter(event => event.event === "end" && event.id === start.id);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ operation: "list", source_id: value.sourceId, database: value.database,
      status: index === 0 ? "completed" : "failed", error_code: index === 0 ? null : "CACHE_MISSING",
      sdk_started: true, metrics_observed: true, request_metrics: { total_requests: 0, trace: [] } });
    const module = index === 0 ? healthy.module : denied.module;
    const calls = (await import(pathToFileURL(module).href)).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].options.database).toBe(value.database);
    expect(calls[0].options.env).toBe(value.env);
    expect(Object.hasOwn(calls[0].options, "sourceId")).toBe(false);
  }
  const serialized = JSON.stringify(events);
  for (const secret of ["PRIVATE_TOKEN_SENTINEL", "PRIVATE_ERROR_MESSAGE_SENTINEL", "PRIVATE_ERROR_DETAILS_SENTINEL"])
    expect(serialized).not.toContain(secret);
});

test("passive SDK failure codes preserve actual typed outcomes and keep unknown codes null", async () => {
  const topic = channel("context-broker.notion-sdk");
  for (const catalogFailure of ["returned", "untyped", "unsafe"] as const) {
    const current = await fixture({ catalog: true, catalogFailure }), events: unknown[] = [];
    const collect = (event: unknown) => events.push(event); topic.subscribe(collect);
    const module = await import(pathToFileURL(current.module).href);
    try {
      if (catalogFailure === "returned") expect(await current.boundary.listNotionCatalogSdk({})).toEqual({ status: "failed", error: module.catalogError });
      else await expect(current.boundary.listNotionCatalogSdk({})).rejects.toBe(module.catalogError);
    } finally { topic.unsubscribe(collect); }
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "start", source_id: null, database: null });
    expect(events[1]).toMatchObject({ event: "end", source_id: null, database: null, status: "failed",
      error_code: catalogFailure === "returned" ? "CACHE_MISSING" : null });
    const serialized = JSON.stringify(events);
    for (const secret of ["PRIVATE_ERROR_MESSAGE_SENTINEL", "PRIVATE_ERROR_DETAILS_SENTINEL", "A".repeat(129)])
      expect(serialized).not.toContain(secret);
  }
});

test("catalog discovery uses one SDK call and never silently falls back when the export is absent", async () => {
  const old = await fixture();
  await expect(old.boundary.listNotionCatalogSdk({})).rejects.toMatchObject({ code: "SOURCE_SDK_INCOMPATIBLE" });
  expect((await import(pathToFileURL(old.module).href)).calls).toHaveLength(0);
  const current = await fixture({ catalog: true });
  const options = { database: "selected", view: "view-id", maxAge: 1000, cwd: "/selected", env: { SDK_TEST_ID: "authorized-scope" } };
  expect(await current.boundary.listNotionCatalogSdk(options)).toEqual({ records: [], count: 0, view: "view-id", scope: "authorized-scope" });
  const calls = (await import(pathToFileURL(current.module).href)).calls;
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ operation: "list", options });
});

test("SC25 current name resolution reuses the pure SDK export without another source runtime", async () => {
  const old = await fixture();
  await expect(old.boundary.resolveNotionCatalogReferenceSdk("skill://Name/SKILL.md", {})).rejects.toMatchObject({ code: "SOURCE_SDK_INCOMPATIBLE" });
  expect((await import(pathToFileURL(old.module).href)).calls).toHaveLength(0);
  const current = await fixture({ resolver: true }), topic = channel("context-broker.notion-sdk"), events: unknown[] = [];
  const collect = (value: unknown) => events.push(value), record = { ref: "skill://canonical/SKILL.md" }, catalog = { scope: "same-scope", records: [record] };
  topic.subscribe(collect);
  try { expect(await current.boundary.resolveNotionCatalogReferenceSdk("skill://Name/SKILL.md", catalog)).toEqual({ target: "skill://Name/SKILL.md", record, scope: catalog.scope, ref: record.ref }); }
  finally { topic.unsubscribe(collect); }
  expect(events).toHaveLength(0); expect((await import(pathToFileURL(current.module).href)).calls).toHaveLength(0);
});

test("SC25 fixed-name files keep one scoped observed operation and reject missing capability before runtime", async () => {
  const old = await fixture(), topic = channel("context-broker.notion-sdk"), events: unknown[] = [];
  const collect = (value: unknown) => events.push(value); topic.subscribe(collect);
  const current = await fixture({ files: true }), controller = new AbortController();
  const target = "skill://Old/SKILL.md?snapshot=fixed", options = { cwd: "/selected", database: "selected-db", offline: true, env: { SDK_TEST_ID: "authorized-scope" }, signal: controller.signal };
  try {
    await expect(old.boundary.listNotionFilesSdk(target, options)).rejects.toMatchObject({ code: "SOURCE_SDK_INCOMPATIBLE" });
    expect(await current.boundary.listNotionFilesSdk(target, options)).toEqual({ target, files: [], scope: "authorized-scope" });
  } finally { topic.unsubscribe(collect); }
  expect((await import(pathToFileURL(old.module).href)).calls).toHaveLength(0);
  const calls = (await import(pathToFileURL(current.module).href)).calls;
  expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ operation: "files", target, options });
  expect(calls[0].options.signal).toBe(controller.signal);
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: "files", event: "end", status: "failed", sdk_started: false, metrics_observed: false }),
    expect.objectContaining({ operation: "files", event: "end", status: "completed", sdk_started: true, metrics_observed: true, request_metrics: { total_requests: 0, trace: [] } }),
  ]));
  expect(JSON.stringify(events)).not.toContain(target); expect(JSON.stringify(events)).not.toContain("authorized-scope");
});

test("raw result evidence is opt-in and correlates with body-free operation metrics", async () => {
  const { boundary } = await fixture();
  const metrics: unknown[] = [], results: unknown[] = [];
  const metricTopic = channel("context-broker.notion-sdk"), resultTopic = channel("context-broker.notion-sdk-result");
  const metricObserver = (event: unknown) => metrics.push(event), resultObserver = (event: unknown) => results.push(event);
  metricTopic.subscribe(metricObserver); resultTopic.subscribe(resultObserver);
  try {
    const value = await boundary.consumeNotionSdk({ source: "PRIVATE_SOURCE_BYTES" }, {});
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ version: 1, operation: "consume", value });
    const event = results[0];
    if (!event || typeof event !== "object" || !("id" in event) || !("value" in event)) throw new Error("Expected correlated actual SDK result");
    expect(event.value).toBe(value);
    expect(metrics).toEqual(expect.arrayContaining([expect.objectContaining({ id: event.id, event: "end", operation: "consume" })]));
    expect(JSON.stringify(metrics)).not.toContain("PRIVATE_SOURCE_BYTES");
  } finally { metricTopic.unsubscribe(metricObserver); resultTopic.unsubscribe(resultObserver); }
  await boundary.consumeNotionSdk({ source: "NO_SUBSCRIBER" }, {});
  expect(results).toHaveLength(1);
});

test("resource capability is additive and checked before entering an older SDK runtime", async () => {
  const { boundary, module } = await fixture();
  await boundary.consumeNotionSdk({}, {});
  await boundary.readNotionSdk("retained", {});
  const events: unknown[] = [], topic = channel("context-broker.notion-sdk");
  const observe = (event: unknown) => events.push(event);
  topic.subscribe(observe);
  try { await expect(boundary.readNotionResourcesSdk({ version: 1, refs: ["resource"] }, {})).rejects.toMatchObject({ code: "SOURCE_SDK_INCOMPATIBLE" }); }
  finally { topic.unsubscribe(observe); }
  expect((await import(pathToFileURL(module).href)).calls).toHaveLength(2);
  expect(events.at(-1)).toMatchObject({ operation: "read-resources", status: "failed", sdk_started: false, metrics_observed: false });
});

test("one resource set enters one SDK operation and does not decode or loop scalar reads", async () => {
  const { boundary, module } = await fixture({ resourceVersion: 1 });
  const request = { version: 1, refs: ["first", "second"], budget: { maxFiles: 16, maxBytes: 1048576, timeBudgetMs: 30000 } };
  expect(await boundary.readNotionResourcesSdk(request, { cwd: "/selected", env: { PRIVATE_TOKEN: "hidden" } })).toEqual({ version: 1, status: "ready", input: request });
  expect((await import(pathToFileURL(module).href)).calls).toHaveLength(1);
  expect((await import(pathToFileURL(module).href)).calls[0]).toMatchObject({ operation: "read-resources", input: request, options: { cwd: "/selected" } });
});

test("the resource version must match the adjacent manifest without disabling consume v1", async () => {
  const { boundary, module } = await fixture({ resourceVersion: 1, resourceManifestVersion: 2 });
  await expect(boundary.readNotionResourcesSdk({}, {})).rejects.toMatchObject({ code: "SOURCE_SDK_INCOMPATIBLE" });
  expect((await import(pathToFileURL(module).href)).calls).toHaveLength(0);
  expect(await boundary.consumeNotionSdk({}, {})).toMatchObject({ status: "ready" });
});

test("scalar output proof is detected without entering an older or current SDK runtime", async () => {
  const older = await fixture();
  expect(await older.boundary.supportsNotionSdkReadOutputProof()).toBe(false);
  expect((await import(pathToFileURL(older.module).href)).calls).toHaveLength(0);
  const current = await fixture({ readProofVersion: 1 });
  expect(await current.boundary.supportsNotionSdkReadOutputProof()).toBe(true);
  expect((await import(pathToFileURL(current.module).href)).calls).toHaveLength(0);
  await current.boundary.readNotionSdk("fixed-resource", { output: "/selected/output" });
  expect((await import(pathToFileURL(current.module).href)).calls).toHaveLength(1);
});

test("advertised scalar output proof must agree with its bundled manifest", async () => {
  for (const options of [{ readProofVersion: 2 }, { readProofVersion: 1, readProofManifestVersion: 2 }, { readProofManifestVersion: 1 }]) {
    const { boundary, module } = await fixture(options);
    await expect(boundary.supportsNotionSdkReadOutputProof()).rejects.toMatchObject({ code: "SOURCE_SDK_INCOMPATIBLE" });
    expect((await import(pathToFileURL(module).href)).calls).toHaveLength(0);
    expect(await boundary.consumeNotionSdk({}, {})).toMatchObject({ status: "ready" });
  }
});
