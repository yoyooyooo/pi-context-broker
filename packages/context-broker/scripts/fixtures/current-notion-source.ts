import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { noConsumptionWrites } from "../../src/consumption-effects";
import type { ContentKind, ContentRecord, SkillRecord, SourceConfig } from "../../src/types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
  : "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
const uuid = (n: number) => "00000000-0000-4000-8000-" + n.toString().padStart(12, "0");
type Input = { version: 1; targets: string[]; purpose: "use" | "inspect"; freshness: { policy: string }; budget?: Record<string, number> };
type Runtime = { database?: string; directory?: { view?: string; profile?: string }; defaultView?: boolean; view?: string; profile?: string; maxAge?: number; refresh?: boolean; offline?: boolean; output?: string; signal?: AbortSignal; execution?: Record<string, unknown> };
type Call = { operation: string; input?: Input; target?: string; options: Runtime };

// Only the external SDK operation is controlled. The source adapter, graph
// decoder, entry/file manifest checks and materialization run unchanged.
export async function currentNotionFixture(kind: ContentKind = "skill", fixture: { identity?: number; name?: string; body?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "broker-current-source-")));
  await cp(new URL("../../src", import.meta.url), join(root, "src"), { recursive: true });
  await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
  await writeFile(join(root, "src/ntn-skills.mjs"), "throw new Error('Unexpected management command in SDK source fixture');\n");
  const module = join(root, "src/ntn-skills-sdk.mjs");
  await writeFile(module, [
    "export const SDK_VERSION=2, CONSUMER_CONTRACT_VERSION=1, PACKAGE_VERSION='current-source-fixture';",
    "export const CONSUMPTION_EFFECTS_VERSION=1, READ_OUTPUT_PROOF_VERSION=1, CATALOG_DIRECTORY_CONTRACT_VERSION=1;",
    "export const calls=[]; let state; export function configure(value){state=value;}",
    "export function parseDuration(value){return value==='1s'?1000:0;}",
    "export function decodeConsumeResult(){throw Error('SDK results must not be decoded twice');}",
    "export async function consume(input,options){calls.push({operation:'consume',input,options}); return state.consume(input,options);}",
    "export async function readSkill(target,options){calls.push({operation:'read',target,options}); return state.read(target,options);}",
    "export async function listSkill(target,options){calls.push({operation:'files',target,options}); return state.listFiles(target,options);}",
    "export function resolveCatalogReference(target,value){return state.resolve(target,value);}",
    "export async function listCatalog(options){calls.push({operation:'list',options}); return state.list(options);}",
  ].join("\n"));
  await writeFile(join(root, "src/ntn-skills-runtime.json"), JSON.stringify({ version: 1, package: "ntn-skills", package_version: "current-source-fixture",
    sdk_version: 2, consumer_contract_version: 1, consumption_effects_version: 1, read_output_proof_version: 1, catalog_directory_contract_version: 1 }));
  const sdk = await import(pathToFileURL(module).href);
  const boundary: typeof import("../../src/notion-source") = await import(pathToFileURL(join(root, "src/notion-source.ts")).href);
  const offset = (fixture.identity ?? 0) * 100, library = fixture.identity === undefined ? "current-source" : "current-source-" + fixture.identity;
  const scope = hash("authorized source"), id = "shared_skill:" + library + ":entry", main = { skill: "SKILL.md", router: "ROUTER.md", prompt: "PROMPT.md" }[kind];
  const body = fixture.body ?? "\ufeff# Current " + kind + "\r\nKeep all author bytes.\r\n";
  const version = hash(body), snapshot = "s_" + hash(JSON.stringify([scope, id, version]));
  const record: ContentRecord = { id, kind, name: fixture.name ?? "entry", alias: fixture.name ?? "entry", description: "Current source", default_context: false, enabled: true,
    entrypoint: main, ref: "skill://" + encodeURIComponent(id) + "/" + main,
    locator: { type: "shared_skill", library_id: library, skill_id: "entry", page_id: uuid(offset + 1), database_id: uuid(offset + 10), data_source_id: uuid(offset + 11) } };
  const bytes = new Map([[main, Buffer.from(body)], ["references/guide.md", Buffer.from("完整参考正文。\r\n")], ["assets/data.bin", Buffer.from([0, 255, 13, 10])]]);
  const bindings = [...bytes.keys()].map((path, index) => ({ path, file_id: "file-" + index, page_id: uuid(offset + index + 1) }));
  const files = [...bytes].map(([path, value], index) => ({ path, bytes: value.length, sha256: hash(value),
    ref: "skill://" + encodeURIComponent(id) + "/" + path + "?snapshot=" + snapshot + "&file_id=file-" + index }));
  const binding = { record, scope, snapshot_id: snapshot, version_id: version, body_sha256: hash(body), ref: files[0]!.ref };
  const source: Extract<SourceConfig, { type: "notion" }> = { type: "notion", id: "notion", database: uuid(offset + 10), cacheDir: join(root, "cache"), activation: { maxAge: "1s" }, prefetch: false };
  const selected: SkillRecord = { ...record, source: "notion", sourceId: source.id, sourceScope: scope, path: join(root, "metadata", main),
    aliases: [], normalizedAliases: [], normalizedName: record.alias, normalizedDescription: record.description, autoloadEnabled: kind !== "prompt" };
  function result(input: Input) {
    const manifest = { complete: true, scope, snapshot_id: snapshot, version_id: version, record, entrypoint: main,
      files: files.map(({ ref: _ref, ...file }) => file), file_bindings: bindings };
    const relations = { required: [], candidates: [], references: [], unresolved_references: [] };
    const node = { state: "prepared", id, ref: binding.ref, roles: ["root"], kind, record, binding, path: main, content: body,
      bytes: Buffer.byteLength(body), body_sha256: hash(body), files, ...relations,
      source: "local_cache", freshness: { policy: "max_age", validated_at: new Date().toISOString(), age_ms: 0, max_age_ms: 1000, stale: false } };
    const vector = { version: 1, kind: "observed_version_vector", purpose: input.purpose, scope, roots: [id], required: [], bindings: [binding] };
    const preparation = { version: 1, status: "ready", purpose: input.purpose, scope,
      roots: [{ target: input.targets[0], id, ref: binding.ref, readiness: "ready" }], nodes: [node], required: [],
      required_closure: input.purpose === "use" ? [id] : [], session_bindings: [binding], graph_lock: { ...vector, sha256: hash(canonical(vector)) },
      budget: { maxNodes: 64, maxDepth: 16, maxInstructionBytes: 1048576, maxContextBytes: 262144, ...input.budget },
      usage: { prepared_nodes: 1, instruction_bytes: node.bytes, context_bytes: node.bytes, max_depth: 0 } };
    return { version: 1, status: "ready", effects: noConsumptionWrites(), preparation, entries: [{ id, manifest, manifest_sha256: hash(canonical(manifest)),
      source_body: { kind: "verified_snapshot_entry", ref: binding.ref, path: main, bytes: node.bytes, sha256: node.body_sha256,
        range: { start: 1, end: body.split("\n").length, total_lines: body.split("\n").length }, has_more: false },
      materialization: { status: "entry_ready", paths: [main] },
      projection: { status: "identity", compiler: "source-identity/v1", source_body_sha256: node.body_sha256,
        relations_sha256: hash(canonical(relations)), projection_sha256: node.body_sha256, bytes: node.bytes } }],
      export: { status: "not_requested" }, delivery: { status: "not_observed" }, activation: { status: "not_evaluated" } };
  }
  let decoder: ((value: unknown, input: Input) => Promise<unknown>) | undefined;
  const core = process.env.CONTEXT_BROKER_GRAPH_CORE;
  if (core) {
    const require = createRequire(join(core, "consumer.ts"));
    const { Effect } = await import(pathToFileURL(require.resolve("effect")).href);
    const { layer } = await import(pathToFileURL(require.resolve("@effect/platform-node/NodeServices")).href);
    const { decodeConsumeResult } = await import(pathToFileURL(join(core, "consumer.ts")).href);
    decoder = (value, input) => Effect.runPromise(decodeConsumeResult(value, input).pipe(Effect.provide(layer)));
  }
  const state = {
    directory: undefined as unknown,
    paired: undefined as unknown,
    filesResponse: undefined as unknown,
    resolve: (target: string, _catalog: unknown): unknown => ({ record, scope, ref: target.replace("entry/", encodeURIComponent(id) + "/") }),
    list(options: Runtime): unknown {
      if (options.directory) return state.paired ?? { version: 1, catalog: { ok: true, value: state.catalog }, directory: { ok: true, value: state.directory ?? state.catalog } };
      return options.defaultView || options.view ? state.directory ?? state.catalog : state.catalog;
    },
    listFiles(_target: string, _options: Runtime): unknown { return state.filesResponse ?? { record, scope, snapshot_id: snapshot, version_id: version, entrypoint: main, ref: binding.ref, freshness: { policy: "pinned" }, files, snapshot_aliases: [record.name, record.alias] }; },
    afterConsume: undefined as (() => void) | undefined,
    transform: (value: ReturnType<typeof result>): unknown => value,
    decoded: 0,
    catalog: { records: [record], count: 1, fetched_at: Date.now(), scope,
      freshness: { policy: "max_age", validated_at: new Date().toISOString(), age_ms: 0, max_age_ms: 1000, stale: false },
      databases: [{ database_id: uuid(offset + 10), title: "Current", alias: "current", role: "content", data_source_ids: [uuid(offset + 11)] }],
      coverage: { method: "explicit_database", exhaustive: true, search_index_limited: false, queried_data_sources: [uuid(offset + 11)], failed_sources: [] } },
    async consume(input: Input, _options: Runtime) {
      const value = state.transform(result(input));
      const verified = decoder ? await decoder(value, input) : value;
      if (decoder) state.decoded++;
      state.afterConsume?.();
      return verified;
    },
    async read(target: string, options: Runtime) {
      const file = files.find(file => file.ref === target);
      if (!file || !options.output) throw Error("Unexpected resource request");
      const value = bytes.get(file.path);
      if (!value) throw Error("Missing fixture resource");
      await writeFile(options.output, value);
      return { record, scope, snapshot_id: snapshot, version_id: version, entrypoint: main, path: file.path, ref: file.ref,
        output: options.output, bytes: file.bytes, sha256: file.sha256, reused: false, file_bindings: bindings,
        freshness: { policy: "pinned" }, effects: noConsumptionWrites() };
    },
  };
  sdk.configure(state);
  const sources: typeof import("../../src/sources") = await import(pathToFileURL(join(root, "src/sources.ts")).href);
  const views: typeof import("../../src/view-discovery") = await import(pathToFileURL(join(root, "src/view-discovery.ts")).href);
  return { root, source, selected, record, body, files, bytes, snapshot, state, boundary, sources, views, calls: sdk.calls as Call[], result,
    manifestHash: (value: unknown) => hash(canonical(value)) };
}
