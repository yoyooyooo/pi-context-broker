import { test, expect } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { channel } from "node:diagnostics_channel";

// These fixtures exercise the loading/observation boundary only. Actual SDK
// runtime, package and Pi proofs use independently installed ntn-skills builds.
async function fixture(options: { sdk?: boolean; sdkVersion?: number; packageVersion?: string; manifestVersion?: string; resourceVersion?: number; resourceManifestVersion?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "broker-sdk-boundary-"));
  await mkdir(join(root, "src")); await mkdir(join(root, "dist"));
  await copyFile(new URL("../src/notion-sdk.ts", import.meta.url), join(root, "src/notion-sdk.ts"));
  const module = join(root, "dist/ntn-skills-sdk.mjs");
  if (options.sdk !== false) await writeFile(module, `
export const SDK_VERSION = ${options.sdkVersion ?? 1};
export const CONSUMER_CONTRACT_VERSION = 1;
export const PACKAGE_VERSION = ${JSON.stringify(options.packageVersion ?? "fixture-1")};
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
    ...(options.resourceVersion === undefined ? {} : { resource_read_contract_version: options.resourceManifestVersion ?? options.resourceVersion }) }));
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
