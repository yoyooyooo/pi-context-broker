import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { noConsumptionWrites } from "../src/consumption-effects";
import { normalizeSources } from "../src/sources";
import { sourceFailureMessage } from "../src/notion-source";
import { installHostSkills, type HostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { buildInjectedContextMessage } from "../src/index";
import { sourceMessageText } from "../src/session-source-snapshot";
import type { AgentMessage, ExtensionAPI, ExtensionContext } from "../src/types";

import { currentNotionFixture as fixture } from "./fixtures/current-notion-source";
import { createHash } from "node:crypto";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (n: number) => "00000000-0000-4000-8000-" + n.toString().padStart(12, "0");
const exists = (path: string) => stat(path).then(() => true, () => false);

test("a settled catalog publishes candidates while the same SDK operation still waits for its View", async () => {
  const f = await fixture();
  let enter!: () => void, release!: () => void, notifications = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let published: ReturnType<typeof f.boundary.readNotionCandidateSnapshot> | undefined;
  f.state.list = async options => {
    options.onCatalogSettled?.();
    enter();
    await held;
    return { version: 1, catalog: { ok: true, value: f.state.catalog }, directory: { ok: true, value: f.state.catalog } };
  };
  let completed = false;
  const discovery = f.boundary.discoverNotionCatalogAndDirectory(f.source, f.root, {}, { onCatalogSettled: source => {
    notifications++;
    published = f.boundary.readNotionCandidateSnapshot(source, f.root);
  } }).finally(() => { completed = true; });
  try {
    await entered;
    expect(notifications).toBe(1);
    expect(completed).toBe(false);
    const snapshot = await published;
    if (snapshot?.kind !== "snapshot") throw new Error("Expected the settled catalog snapshot");
    expect(snapshot.candidates).toHaveLength(1);
    expect(await exists(f.source.cacheDir!)).toBe(false);
    expect(f.calls.map(call => call.operation)).toEqual(["list", "candidates"]);
  } finally { release(); await discovery; }
  expect(notifications).toBe(1);
});

test("an early combined discovery refusal publishes its local denial once and cancelled discovery stays silent", async () => {
  for (const cancelled of [false, true]) {
    const f = await fixture(), controller = new AbortController();
    let notifications = 0;
    f.state.list = async () => {
      if (cancelled) controller.abort();
      throw { code: "ACCESS_DENIED" };
    };
    const error = await f.boundary.discoverNotionCatalogAndDirectory(f.source, f.root, {}, {
      signal: controller.signal, onCatalogSettled: () => { notifications++; },
    }).catch(error => error);
    expect(error.code).toBe(cancelled ? "SOURCE_CANCELLED" : "ACCESS_DENIED");
    expect(notifications).toBe(cancelled ? 0 : 1);
  }
});

test("custom Notion CLI configuration is retired with an actionable upgrade error", () => {
  for (const command of ["ntn-skills", ["node", "/old/ntn-skills.js"]])
    expect(() => normalizeSources([{ type: "notion", id: "current", command }])).toThrow(expect.objectContaining({ code: "SOURCE_COMMAND_UNSUPPORTED" }));
  expect(sourceFailureMessage("SOURCE_COMMAND_UNSUPPORTED")).toContain("Remove that override");
  expect(normalizeSources([{ type: "notion", id: "current", library: uuid(10) }])?.[0]).not.toHaveProperty("command");
});

test("an explicit root routes directly without consulting an unrelated failing Library", async () => {
  for (const code of ["LIBRARY_SCOPE_MISMATCH", "SKILL_NOT_FOUND", "ACCESS_DENIED", "CATALOG_INCOMPLETE"]) {
    const f = await fixture(), unrelated = { ...f.source, id: "unrelated", library: uuid(90) };
    const ownFiles = f.state.listFiles.bind(f.state);
    f.state.listFiles = (target, options) => {
      if (options.library === unrelated.library) throw Object.assign(new Error("Foreign Library failure"), { code });
      return ownFiles(target, options);
    };
    const selected = await f.boundary.resolveNotionReference(f.files[1]!.ref, [unrelated, f.source], f.root);
    expect(selected.ref).toBe(f.files[1]!.ref);
    expect(selected.record.sourceId).toBe(f.source.id);
    expect(f.calls.map(call => [call.operation, call.options.library])).toEqual([["files", f.source.library]]);
  }
});

test("the selected Library's denial is never hidden by a same-name Skill elsewhere", async () => {
  const f = await fixture(), unrelated = { ...f.source, id: "unrelated", library: uuid(90) };
  f.state.listFiles = () => { throw Object.assign(new Error("denied"), { code: "ACCESS_DENIED" }); };
  await expect(f.boundary.resolveNotionReference(f.files[1]!.ref, [unrelated, f.source], f.root)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(f.calls.map(call => call.options.library)).toEqual([f.source.library]);
});

test("current Skill, Router and Prompt loads use one SDK consume and retain the complete file directory", async () => {
  for (const kind of ["skill", "router", "prompt"] as const) {
    const f = await fixture(kind), loaded = await f.boundary.loadNotionSkill(f.selected, f.source, f.root);
    expect(loaded.body).toBe(f.body); expect(await readFile(loaded.path, "utf8")).toBe(f.body);
    expect(loaded.entryManifest).toMatchObject({ manifest_complete: true, local_files_ready: false, materialized_paths: [f.record.entrypoint] });
    expect(loaded.entryManifest?.files).toEqual([...f.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ operation: "consume", input: { purpose: "inspect", freshness: { policy: "max_age", max_age_ms: 1000 } } });
    expect(f.calls[0]!.options).not.toHaveProperty("readOnly");
    expect(await exists(join(f.source.cacheDir!, "snapshots"))).toBe(false);
    for (const file of f.files.slice(1)) {
      expect(await exists(join(loaded.entryManifest!.root, file.path))).toBe(false);
      const path = await f.boundary.loadNotionResource(loaded, file.path, f.source, f.root);
      expect(await readFile(path)).toEqual(f.bytes.get(file.path));
    }
    expect(loaded.entryManifest?.local_files_ready).toBe(true);
    expect(f.calls.map(call => call.operation)).toEqual(["consume", "read", "read"]);
    if (process.env.CONTEXT_BROKER_GRAPH_CORE) expect(f.state.decoded).toBe(1);
  }
});

test("Source main and sparse Notion bindings retain every source path and exact resource bytes", async () => {
  for (const boundPaths of [[], ["references/guide.md"]]) {
    const f = await fixture("skill", { boundPaths });
    const loaded = await f.boundary.loadNotionSkill(f.selected, f.source, f.root);
    expect(loaded.body).toBe(f.body);
    expect(await readFile(loaded.path, "utf8")).toBe(f.body);
    expect(loaded.preparationBinding?.ref).not.toContain("file_id=");
    expect(loaded.fileBindings?.map(binding => binding.path)).toEqual(boundPaths);
    expect(loaded.entryManifest?.files).toEqual([...f.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const file of f.files) expect(file.ref).not.toContain("file_id=");
    for (const file of f.files.slice(1)) {
      const path = await f.boundary.loadNotionResource(loaded, file.path, f.source, f.root);
      expect(await readFile(path)).toEqual(f.bytes.get(file.path));
    }
    expect(loaded.entryManifest?.local_files_ready).toBe(true);
    expect(f.calls.map(call => call.operation)).toEqual(["consume", "read", "read"]);
    if (process.env.CONTEXT_BROKER_GRAPH_CORE) expect(f.state.decoded).toBe(1);
  }
});

test("Pi explicitly submits Prompt source bytes in both turns without activating it as a Skill", async () => {
  const f = await fixture("prompt");
  const events = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const api: ExtensionAPI = { on(name, listener) { events.set(name, [...events.get(name) ?? [], listener]); } };
  const ctx: ExtensionContext = { cwd: f.root, hasUI: false, mode: "rpc" };
  const emit = async (name: string, event: unknown) => Promise.all((events.get(name) ?? []).map(listener => listener(event as never, ctx)));
  let host: HostSkills;
  let skillGraphCalls = 0, activated = 0;
  host = await installHostSkills(api, {
    config: { sources: [f.source] },
    getRecords: async () => ({ records: [f.selected], failures: [] }),
    loadRecord: (record, signal, snapshotId, policy) => f.boundary.loadNotionSkill(record, f.source, f.root, { signal, snapshotId, ...policy }),
    prepareGraph: async () => { skillGraphCalls++; throw Error("Prompt must not expand Skill Requires"); },
    needsPreflightPrompt: text => text.includes("$entry"),
    preflightPrompt: async (_text, context, signal) => host.prepareMany([f.selected], context, signal),
    buildPreparedPrompt: async (_text, _context, _signal, prepared) => {
      expect(prepared).toHaveLength(1); expect(prepared[0]?.kind).toBe("prompt");
      expect(prepared[0]?.autoloadEnabled).toBe(false);
      return buildInjectedContextMessage(prepared[0]!, "entry");
    },
    confirmDelivery: records => { activated += records.length; },
  }, createPiHostAdapter(api));
  for (const turn of [1, 2]) {
    const user: AgentMessage = { role: "user", content: "$entry task " + turn };
    await emit("input", { source: "rpc", text: user.content });
    await emit("before_agent_start", { prompt: user.content, systemPrompt: "base" });
    await emit("agent_start", {});
    const values = await emit("context", { messages: [user] });
    const projection = values.find((value): value is { messages: AgentMessage[] } => Boolean(value && typeof value === "object" && "messages" in value));
    expect(projection).toBeDefined();
    const delivered = projection!.messages.map(message => sourceMessageText(message.content)).join("\n");
    expect(delivered.split(f.body)).toHaveLength(2);
    expect(f.calls).toHaveLength(turn);
    await emit("before_provider_request", {});
    await emit("after_provider_response", { status: 200 });
    await emit("agent_end", {});
  }
  expect(f.calls.map(call => call.operation)).toEqual(["consume", "consume"]);
  expect(skillGraphCalls).toBe(0); expect(activated).toBe(0);
  if (process.env.CONTEXT_BROKER_GRAPH_CORE) expect(f.state.decoded).toBe(2);
});

test.skipIf(!process.env.CONTEXT_BROKER_GRAPH_CORE)("a partial or inconsistent manifest cannot be published as a complete entry", async () => {
  for (const defect of ["incomplete", "missing-resource", "bad-hash"] as const) {
    const f = await fixture();
    f.state.transform = value => {
      const entry = value.entries[0]!;
      if (defect === "incomplete") entry.manifest.complete = false;
      else if (defect === "missing-resource") {
        entry.manifest.files.pop();
        entry.manifest_sha256 = f.manifestHash(entry.manifest);
      }
      else entry.manifest_sha256 = hash("wrong manifest");
      return value;
    };
    await expect(f.boundary.loadNotionSkill(f.selected, f.source, f.root)).rejects.toBeDefined();
    expect(f.calls).toHaveLength(1); expect(await exists(f.source.cacheDir!)).toBe(false);
  }
});

test.skipIf(!process.env.CONTEXT_BROKER_GRAPH_CORE)("current SDK observations cannot reuse a retained content-only snapshot identity", async () => {
  const f = await fixture("skill", { legacySnapshot: true });
  await expect(f.boundary.loadNotionSkill(f.selected, f.source, f.root)).rejects.toMatchObject({ code: "CONSUME_INVALID_PROOF" });
  expect(f.calls).toHaveLength(1); expect(f.state.decoded).toBe(0);
  expect(await exists(f.source.cacheDir!)).toBe(false);
});

test("background prefetch uses the same bounded SDK operation without publishing a host tree", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  const result = await f.boundary.prefetchNotionSkills({ source: f.source, records: [f.selected],
    budget: { maxNodes: 1, maxDepth: 0, maxBytes: 65536, maxTimeMs: 5000, rateShare: 0.1 } }, f.root, signal);
  expect(result.preparedNodes).toBe(1); expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ operation: "consume", input: { purpose: "inspect", budget: { maxNodes: 1, maxDepth: 0, maxInstructionBytes: 65536 } },
    options: { signal, execution: { priority: "prefetch", timeBudgetMs: 5000, queueBudgetMs: 1000, rateShare: 0.1 } } });
  expect(f.calls[0]!.options).not.toHaveProperty("readOnly");
  expect(await exists(f.source.cacheDir!)).toBe(false);
});

test("current acquisition failures retain their next action across catalog, body and resource operations", async () => {
  const f = await fixture(), loaded = await f.boundary.loadNotionSkill(f.selected, f.source, f.root);
  for (const [received, code, action] of [
    ["SKILL_DISABLED", "CONTENT_DISABLED", "disabled"],
    ["CACHE_REFRESH_REQUIRED", "CACHE_REFRESH_REQUIRED", "Refresh the source online"],
    ["STATE_CUTOVER_REQUIRED", "STATE_CUTOVER_REQUIRED", "fresh NTN_SKILLS_HOME"],
    ["STATE_UNAVAILABLE", "STATE_UNAVAILABLE", "Restore access to the existing state directory"],
    ["UPSTREAM_GIT_RUNTIME_UNSUPPORTED", "UPSTREAM_GIT_RUNTIME_UNSUPPORTED", "--no-lazy-fetch"],
    ["CURRENT_SOURCE_REQUIRED", "CURRENT_SOURCE_REQUIRED", "Migrate its current content"],
    ["CURRENT_SCHEMA_REQUIRED", "CURRENT_SCHEMA_REQUIRED", "authorized management migration"],
    ["SHARED_ACQUISITION_SCOPE", "SHARED_ACQUISITION_SCOPE", "select its current content"],
    ["SHARED_SOURCE_MISSING", "SHARED_SOURCE_MISSING", "select its current content"],
    ["SHARED_SOURCE_CONFLICT", "SHARED_SOURCE_CONFLICT", "select its current content"],
    ["SOURCE_MATERIALIZATION_INCOMPLETE", "SOURCE_MATERIALIZATION_INCOMPLETE", "Inspect the source content"],
    ["SHARED_RESOURCE_CONTENT_INVALID", "SHARED_RESOURCE_CONTENT_INVALID", "Inspect the source content"],
  ] as const) {
    f.state.list = async () => { throw { code: received }; };
    f.state.read = async () => { throw { code: received }; };
    f.state.transform = () => ({ version: 1, status: "failed", effects: noConsumptionWrites(), error: { code: received, message: "controlled current failure" } });
    await expect(f.boundary.discoverNotionSource(f.source, f.root)).rejects.toMatchObject({ code });
    await expect(f.boundary.loadNotionSkill(f.selected, f.source, f.root)).rejects.toMatchObject({ code });
    await expect(f.boundary.loadNotionResource(loaded, f.files[1]!.path, f.source, f.root)).rejects.toMatchObject({ code });
    expect(sourceFailureMessage(code)).toContain(action);
  }
  f.state.read = async () => { throw { code: "UPSTREAM_GIT_RUNTIME_UNSUPPORTED", details: {
    required_capability: "--no-lazy-fetch", observed_version: "git version 2.39.5 (Apple Git-154)", token: "private source detail",
  } }; };
  const unsupported = await f.boundary.loadNotionResource(loaded, f.files[1]!.path, f.source, f.root).catch(error => error);
  expect(unsupported).toMatchObject({ code: "UPSTREAM_GIT_RUNTIME_UNSUPPORTED", details: {
    required_capability: "--no-lazy-fetch", observed_version: "git version 2.39.5 (Apple Git-154)",
  } });
  expect(unsupported.details).not.toHaveProperty("token");
  f.state.read = async () => { throw { code: "UNRECOGNIZED_ERROR", message: "private source detail" }; };
  await expect(f.boundary.loadNotionResource(loaded, f.files[1]!.path, f.source, f.root)).rejects.toMatchObject({ code: "SOURCE_SDK_FAILED" });
  expect(await exists(join(loaded.entryManifest!.root, f.files[1]!.path))).toBe(false);
  expect(loaded.entryManifest?.local_files_ready).toBe(false);
});

test("SDK failures, cancellation and foreign scopes never publish a ready entry or start a second transport", async () => {
  const denied = await fixture();
  denied.state.transform = () => ({ version: 1, status: "failed", effects: noConsumptionWrites(), error: { code: "ACCESS_DENIED", message: "denied" } });
  await expect(denied.boundary.loadNotionSkill(denied.selected, denied.source, denied.root)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(denied.calls).toHaveLength(1); expect(await exists(denied.source.cacheDir!)).toBe(false);
  const cancelled = await fixture(), controller = new AbortController(); cancelled.state.afterConsume = () => controller.abort();
  await expect(cancelled.boundary.loadNotionSkill(cancelled.selected, cancelled.source, cancelled.root, { signal: controller.signal })).rejects.toMatchObject({ code: "SOURCE_CANCELLED" });
  expect(cancelled.calls).toHaveLength(1); expect(await exists(cancelled.source.cacheDir!)).toBe(false);
  const foreign = await fixture();
  await expect(foreign.boundary.loadNotionSkill({ ...foreign.selected, sourceScope: hash("foreign") }, foreign.source, foreign.root)).rejects.toMatchObject({ code: "SOURCE_PREPARATION_INVALID" });
  expect(foreign.calls).toHaveLength(1); expect(await exists(foreign.source.cacheDir!)).toBe(false);
});

test("candidate snapshots publish exact metadata without host projections or consumption authority", async () => {
  const f = await fixture();
  const value = await f.boundary.readNotionCandidateSnapshot(f.source, f.root);
  expect(value.kind).toBe("snapshot");
  if (value.kind !== "snapshot") throw new Error("Expected cached candidate snapshot");
  expect(value.candidates).toHaveLength(1);
  const candidate = value.candidates[0]!;
  expect(candidate).toMatchObject({ origin: "notion", scope: f.state.catalog.scope, record: { id: f.record.id, locator: f.record.locator } });
  expect(candidate.record).not.toHaveProperty("path");
  expect(candidate.record).not.toHaveProperty("currentObservation");
  expect(await exists(f.source.cacheDir!)).toBe(false);
  expect(f.calls.map(call => call.operation)).toEqual(["candidates"]);
  const selected = await f.boundary.materializeCompletionCandidate(candidate, f.root);
  expect(await exists(selected.path)).toBe(true);
  expect(selected).not.toHaveProperty("currentObservation");
  expect(selected.locator).toEqual(f.record.locator);
  expect(selected.sourceScope).toBe(f.state.catalog.scope);
  expect(f.calls.map(call => call.operation)).toEqual(["candidates"]);
  const loaded = await f.boundary.loadNotionSkill(selected, f.source, f.root);
  expect(loaded.body).toBe(f.body);
  expect(f.calls.map(call => call.operation)).toEqual(["candidates", "consume"]);
});

test("cached denial clears remote candidates and malformed snapshots never become host records", async () => {
  const denied = await fixture();
  denied.state.catalogFailure = "ACCESS_DENIED";
  expect(await denied.boundary.readNotionCandidateSnapshot(denied.source, denied.root)).toMatchObject({ kind: "blocked", candidates: [] });
  expect(await exists(denied.source.cacheDir!)).toBe(false);
  const foreign = await fixture();
  foreign.state.catalog = { ...foreign.state.catalog, records: [{ ...foreign.record, locator: { ...foreign.record.locator, library_id: uuid(199) } }] };
  await expect(foreign.boundary.readNotionCandidateSnapshot(foreign.source, foreign.root)).rejects.toBeDefined();
  expect(await exists(foreign.source.cacheDir!)).toBe(false);
});
