import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadNotionResource, prepareNotionSkills, prefetchNotionSkills, SourceError } from "../src/notion-source";
import type { ContentRecord, SkillRecord, SourceConfig } from "../src/types";

const cli = process.env.CONTEXT_BROKER_GRAPH_CLI;
const core = process.env.CONTEXT_BROKER_GRAPH_CORE;
const evidence = process.env.CONTEXT_BROKER_GRAPH_EVIDENCE;
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const node = Bun.which("node")!;
async function command(args: string[], env?: NodeJS.ProcessEnv) {
  const child = spawn(node, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = await new Promise<number | null>((done, fail) => { child.on("error", fail); child.on("close", done); });
  if (exit !== 0) throw new Error("Controlled Node process failed: " + stderr + stdout);
  return stdout;
}
async function fixture(missing = false, bom = false) {
  if (!cli || !core) throw new Error("Set CONTEXT_BROKER_GRAPH_CLI and CONTEXT_BROKER_GRAPH_CORE for real Node/SQLite verification");
  if (evidence) await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(join(evidence ?? tmpdir(), "broker-prepare-sqlite-"));
  const scope = hash("broker-prepare-controlled-scope");
  const token = "broker-prepare-controlled-offline-token", origin = "http://127.0.0.1:9";
  const env = {
    ...process.env, NOTION_API_TOKEN: token, NOTION_WORKSPACE_ID: "", NOTION_API_BASE_URL: origin,
    NTN_SKILLS_HOME: join(root, "state"), NTN_SKILLS_CONFIG_HOME: join(root, "config"), NTN_SKILLS_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "xdg-state"), XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_CACHE_HOME: join(root, "xdg-cache"),
  };
  const records = ["root", "required", "member"].map((name, index): ContentRecord => {
    const id = "shared_skill:broker-prepare:" + name;
    return {
      id, kind: "skill", name, alias: name, description: "Controlled " + name, default_context: index === 0, enabled: true,
      entrypoint: "SKILL.md", ref: "skill://" + encodeURIComponent(id) + "/SKILL.md",
      locator: { type: "shared_skill", library_id: "broker-prepare", skill_id: name, page_id: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
        database_id: "00000000-0000-4000-8000-000000000010", data_source_id: "00000000-0000-4000-8000-000000000011" },
    };
  });
  const bodies = records.map(record => (bom ? "\ufeff" : "") + "---\r\nname: " + record.name + "\r\ndescription: " + record.description + "\r\n---\r\nExact " + record.name + " instructions.\r\n");
  const resources = [
    { path: "moved/guide.md", file_id: "guide-root", bytes: Buffer.from("Exact retained guide.\r\n") },
    { path: "assets/example.bin", file_id: "binary-root", bytes: Buffer.from([0, 255, 128, 13, 10, 1, 239, 187, 191]) },
    { path: "unused/large.txt", file_id: "large-root", bytes: Buffer.alloc(262144, 65) },
  ];
  const snapshots = records.map((record, index) => ({
    record, scope, snapshot_id: "s_" + hash(JSON.stringify([scope, record.id, hash(bodies[index]!)])), version_id: hash(bodies[index]!),
    created_at: 1000, entrypoint: record.entrypoint,
    files: [{ path: "SKILL.md", bytes: Buffer.byteLength(bodies[index]!), sha256: hash(bodies[index]!) }],
    file_bindings: [{ file_id: "main-" + record.name, page_id: record.locator.type === "shared_skill" ? record.locator.page_id : "", path: "SKILL.md" }],
    required: [] as Array<{ id: string; ref: string; metadata: ContentRecord }>,
    members: [] as Array<{ id: string; ref: string; metadata: ContentRecord }>,
  }));
  const relation = (index: number) => ({ id: records[index]!.id, ref: records[index]!.ref + "?snapshot=" + snapshots[index]!.snapshot_id + "&file_id=main-" + records[index]!.name, metadata: records[index]! });
  for (const [index, file] of resources.entries()) {
    snapshots[0]!.files.push({ path: file.path, bytes: file.bytes.length, sha256: hash(file.bytes) });
    snapshots[0]!.file_bindings.push({ path: file.path, file_id: file.file_id, page_id: "00000000-0000-4000-8000-" + String(index + 101).padStart(12, "0") });
  }
  snapshots[0]!.required = [relation(1)]; snapshots[0]!.members = [relation(2)];
  const seed = `
import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
import {Effect,Layer} from ${JSON.stringify(import.meta.resolve("effect"))};
import {Store,StoreLive} from ${JSON.stringify(join(core, "store.ts"))};
import {currentMaterializationVersion} from ${JSON.stringify(join(core, "materialization.ts"))};
const snapshots=${JSON.stringify(snapshots)}, bodies=${JSON.stringify(bodies)}, resources=${JSON.stringify(resources.map(file => ({ ...file, bytes: file.bytes.toString("base64"), sha256: hash(file.bytes) })))};
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
 const store=yield* Store;
 yield* store.writeJson(${JSON.stringify("cache/identities/" + hash(JSON.stringify([hash(token), "", origin])) + ".json")},{scope:${JSON.stringify(scope)}});
 for(const resource of resources)yield* store.writeBytes("objects/"+resource.sha256,Buffer.from(resource.bytes,"base64"));
 for(let i=0;i<snapshots.length;i++){
  if(${missing} && i===1)continue;
  yield* store.writeBytes("objects/"+snapshots[i].files[0].sha256,new TextEncoder().encode(bodies[i]));
  yield* store.writeJson("snapshots/"+snapshots[i].snapshot_id+".json",snapshots[i]);
  yield* store.writeJson("cache/latest/"+snapshots[i].scope+"/"+snapshots[i].record.id+"/fixture.json",{
   record_identity:snapshots[i].record.id,scope:snapshots[i].scope,started_at:Date.now(),generation:1,
   materialization_version:currentMaterializationVersion(snapshots[i].record.id),validated_at:Date.now(),
   snapshot_id:snapshots[i].snapshot_id,default_context:snapshots[i].record.default_context,invalidated:false,shared_body_valid_until:Date.now()+3600000
  });
 }
})).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer)))));
`;
  await writeFile(join(root, "seed-input.json"), JSON.stringify({ snapshots, bodies }, null, 2));
  await command(["--input-type=module", "-e", seed], env);
  const wrapper = join(root, "source.mjs"), ledger = join(root, "calls.jsonl");
  const sourceEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("NTN_SKILLS_") || key.startsWith("XDG_") || key.startsWith("NOTION_")));
  await writeFile(wrapper, `
import {spawn} from "node:child_process";import{appendFileSync}from"node:fs";
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(ledger)},JSON.stringify({args})+"\\n");
const child=spawn(process.execPath,[${JSON.stringify(cli)},...args],{env:{...process.env,...${JSON.stringify(sourceEnv)}},stdio:"inherit"});
child.on("exit",(code,signal)=>{process.exitCode=code??(signal?130:1)});
`);
  const source: Extract<SourceConfig, { type: "notion" }> = { id: "controlled", type: "notion", command: [node, wrapper], cacheDir: join(root, "broker"), activation: { offline: true }, prefetch: false };
  const selected: SkillRecord = { ...records[0]!, source: "notion", sourceId: source.id, sourceScope: scope, path: join(root, "metadata", "SKILL.md"),
    aliases: [], normalizedAliases: [], normalizedName: records[0]!.name, normalizedDescription: records[0]!.description, autoloadEnabled: true };
  return { root, source, selected, snapshots, bodies, resources, rootPins: new Map([[selected.id!, snapshots[0]!.snapshot_id]]), ledger };
}
const real = test.skipIf(!cli || !core);
real("public prepare through real Node/SQLite materializes root and Required, leaves Member unexpanded and preserves pins", async () => {
  const f = await fixture();
  const graph = await prepareNotionSkills([f.selected], f.source, f.root, { purpose: "use", rootPins: f.rootPins });
  expect(graph.records.map(record => record.name)).toEqual(["required", "root"]);
  for (const record of graph.records) {
    expect(record.body).toBe(f.bodies[record.name === "root" ? 0 : 1]);
    expect(await readFile(record.path, "utf8")).toBe(record.body);
    expect(record.preparationBinding?.body_sha256).toBe(hash(record.body!));
    expect(record.fileBindings?.[0]?.file_id).toBe("main-" + record.name);
  }
  const inspected = await prepareNotionSkills([f.selected], f.source, f.root, { purpose: "inspect", rootPins: f.rootPins, sessionBindings: graph.bindings });
  expect(inspected.records.map(record => record.name)).toEqual(["root"]);
  expect(inspected.records[0]?.snapshotId).toBe(f.snapshots[0]!.snapshot_id);
  const calls = (await readFile(f.ledger, "utf8")).trim().split("\n").map(line => JSON.parse(line).args as string[]);
  expect(calls.filter(args => args[0] === "read").every(args => !args[1]!.includes("member"))).toBe(true);
  expect(calls.some(args => args.includes("--session-bindings"))).toBe(true);
  expect(calls.some(args => args[0] === "export")).toBe(false);
  const root = graph.records.find(record => record.name === "root")!;
  expect(root.entryManifest?.manifest_complete).toBe(true);
  expect(root.entryManifest?.local_files_ready).toBe(false);
  expect(root.entryManifest?.materialized_paths).toEqual(["SKILL.md"]);
  expect(root.entryManifest?.files).toHaveLength(4);
  expect(await stat(join(dirname(root.path), ".broker-snapshot.json")).then(() => true, () => false)).toBe(false);
  expect(await stat(join(dirname(root.path), "unused/large.txt")).then(() => true, () => false)).toBe(false);
});
real("missing Required and node budget failures retain structured provenance and produce no exported body", async () => {
  for (const missing of [true, false]) {
    const f = await fixture(missing);
    if (!missing) f.source.preparation = { maxNodes: 1 };
    let caught: unknown;
    try { await prepareNotionSkills([f.selected], f.source, f.root, { purpose: "use", rootPins: f.rootPins }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(SourceError);
    if (!(caught instanceof SourceError)) throw caught;
    expect(caught.code).toBe(missing ? "SNAPSHOT_MISSING" : "PREPARE_NODE_BUDGET");
    expect(caught.details?.preparation).toHaveProperty("status", "partial");
    expect(await readFile(f.ledger, "utf8")).not.toContain('"export"');
  }
});
real("complete BOM and CRLF bytes survive prepare, public read and entry-ready storage", async () => {
  const f = await fixture(false, true);
  const graph = await prepareNotionSkills([f.selected], f.source, f.root, { purpose: "use", rootPins: f.rootPins });
  for (const record of graph.records) {
    expect(record.body?.startsWith("\ufeff")).toBe(true);
    expect(record.body).toBe(f.bodies[record.name === "root" ? 0 : 1]);
  }
});
real("partial entries fetch only the selected exact File ID through public binary-safe read output", async () => {
  const f = await fixture();
  const graph = await prepareNotionSkills([f.selected], f.source, f.root, { purpose: "inspect", rootPins: f.rootPins });
  const root = graph.records[0]!;
  expect(root.entryManifest?.materialized_paths).toEqual(["SKILL.md"]);
  for (const file of f.resources.slice(0, 2)) {
    const path = await loadNotionResource(root, file.path, f.source, f.root);
    expect(await readFile(path)).toEqual(file.bytes);
    expect(root.entryManifest?.materialized_paths).toContain(file.path);
  }
  expect(root.entryManifest?.local_files_ready).toBe(false);
  expect(await stat(join(root.entryManifest!.root, "unused/large.txt")).then(() => true, () => false)).toBe(false);
  const calls = (await readFile(f.ledger, "utf8")).trim().split("\n").map(line => JSON.parse(line).args as string[]);
  expect(calls.some(args => args[0] === "export")).toBe(false);
  const resources = calls.filter(args => args[0] === "read" && args.includes("--output"));
  expect(resources).toHaveLength(2);
  for (const [index, args] of resources.entries()) {
    expect(args[1]).toContain("?snapshot=" + root.snapshotId + "&file_id=" + f.resources[index]!.file_id);
  }
  const before = calls.length;
  await expect(loadNotionResource(root, "../SKILL.md", f.source, f.root)).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  expect((await readFile(f.ledger, "utf8")).trim().split("\n")).toHaveLength(before);
  const afterRestart = await prepareNotionSkills([f.selected], f.source, f.root, { purpose: "inspect", rootPins: f.rootPins });
  expect(afterRestart.records[0]!.entryManifest?.materialized_paths).toEqual(["SKILL.md"]);
  expect(await readFile(await loadNotionResource(afterRestart.records[0]!, "moved/guide.md", f.source, f.root))).toEqual(f.resources[0]!.bytes);
});
real("budget prefetch uses public inspect only and cannot publish a host snapshot or select a session version", async () => {
  const f = await fixture();
  const prepared = await prefetchNotionSkills({
    source: f.source, records: [f.selected],
    budget: { maxNodes: 1, maxBytes: 65536, maxDepth: 0, maxTimeMs: 5000, rateShare: 0.1 },
  }, f.root, new AbortController().signal);
  expect(prepared.preparedNodes).toBe(1);
  expect(prepared.records.map(record => record.id)).toEqual([f.selected.id!]);
  expect(prepared.instructionBytes).toBe(Buffer.byteLength(f.bodies[0]!));
  expect("body" in prepared).toBe(false);
  expect("lock" in prepared).toBe(false);
  expect(await stat(f.source.cacheDir!).then(() => true, () => false)).toBe(false);
  const calls = (await readFile(f.ledger, "utf8")).trim().split("\n").map(line => JSON.parse(line).args as string[]);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("--priority");
  expect(calls[0]).toContain("prefetch");
  expect(calls[0]).toContain("inspect");
  expect(calls[0]).not.toContain("--session-bindings");
  const selected = await prepareNotionSkills([f.selected], f.source, f.root, { purpose: "use", rootPins: f.rootPins });
  expect(selected.records.map(record => record.name)).toEqual(["required", "root"]);
});
