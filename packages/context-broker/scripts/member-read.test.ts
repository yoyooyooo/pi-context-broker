import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installHostSkills } from "../src/host-skills";
import type { HostCapabilities } from "../src/host-adapter";
import type { ExtensionAPI, ExtensionContext, SkillRecord } from "../src/types";

// Exercise the same recorded native extension hooks used by input-guard.test.ts.
const root = await realpath(await mkdtemp(join(tmpdir(), "broker-member-read-")));
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const removedId = "33333333-3333-4333-8333-333333333333";
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
try {
  const record = async (id: string, sourceId: string, name: string, entrypoint = "SKILL.md", kind: "skill" | "router" = "skill"): Promise<SkillRecord> => {
    const path = join(root, "metadata", sourceId, id, entrypoint);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "metadata only");
    return { id: "notion_page:" + id, kind, name, description: "member fixture", aliases: [], normalizedName: name, normalizedDescription: "member fixture", normalizedAliases: [], autoloadEnabled: true, defaultDiscovery: kind === "router", source: "notion", sourceId, sourceScope: sourceId === "selected" ? "a".repeat(64) : "b".repeat(64), token: `${sourceId}/${name}`, path, metadataIndexPath: path, entrypoint, ref: `skill://${id}/${entrypoint}` };
  };
  const first = await record(firstId, "selected", "first");
  const second = await record(secondId, "selected", "shared-name", "nested/SKILL.md");
  const wrongSource = await record(secondId, "other", "shared-name", "nested/SKILL.md");
  const nameTrap = await record(removedId, "other", removedId);
  nameTrap.ref = "skill://55555555-5555-4555-8555-555555555555/SKILL.md";
  nameTrap.token = removedId;
  const router = await record("44444444-4444-4444-8444-444444444444", "selected", "router", "ROUTER.md", "router");
  const bodies = new Map<SkillRecord, string>([
    [first, `First Skill\n[second](skill://${secondId}/references/deep/selected.md)\n`],
    [second, "SECOND_SELECTED_BODY\n"], [wrongSource, "WRONG_SOURCE_BODY\n"],
    [nameTrap, "UUID_NAME_TRAP\n"], [router, `Members: ${first.ref}, ${second.ref}\n`],
  ]);
  const resource = "EXACT_SELECTED_MEMBER_RESOURCE\n";
  const calls: SkillRecord[] = [];
  const snapshots = new Map<SkillRecord, string>();
  for (const item of bodies.keys()) {
    const directory = join(root, "snapshots", item.sourceId!, item.id!);
    const path = join(directory, item.entrypoint!);
    await mkdir(dirname(path), { recursive: true });
    await mkdir(join(directory, "references/deep"), { recursive: true });
    await writeFile(path, bodies.get(item)!);
    await writeFile(join(directory, "references/deep/selected.md"), item === second ? resource : "WRONG_RESOURCE\n");
    snapshots.set(item, path);
  }
  await writeFile(join(root, "outside.md"), "OUTSIDE\n");
  await symlink(join(root, "outside.md"), join(dirname(snapshots.get(first)!), "escape.md"));
  type Listener = (event: never, ctx: ExtensionContext) => unknown;
  const listeners = new Map<string, Listener[]>();
  const api: ExtensionAPI = { on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler as unknown as Listener]); } };
  const adapter: HostCapabilities = {
    paths: {}, submission: { mode: "transform", receipt: "input-digest" },
    registerCatalog: async () => true, handledInput: { action: "handled" }, continuedInput: undefined,
    transformInput: text => ({ action: "transform", text }), buildPrompt: async snapshot => snapshot.body!,
    installEditor: async () => {}, updatedRead: input => ({ input }), reload: async () => {},
  };
  const ctx: ExtensionContext = { mode: "rpc", cwd: root, sessionManager: { getSessionId: () => "member-read" } };
  let records = [...bodies.keys()];
  const host = await installHostSkills(api, {
    config: {}, getRecords: async () => ({ records, failures: [] }),
    loadRecord: async selected => {
      calls.push(selected);
      const item = [...bodies.keys()].find(item => item.id === selected.id && item.sourceId === selected.sourceId)!;
      assert.ok(item, "Only an exact registered source record may load");
      return { ...selected, path: snapshots.get(item)!, body: await readFile(snapshots.get(item)!, "utf8"), snapshotId: "s_" + hash(bodies.get(item)!) };
    },
  }, adapter);
  const emit = async (name: string, event: unknown) => {
    let result: unknown;
    for (const listener of listeners.get(name) ?? []) result = await listener(event as never, ctx);
    return result as { block?: boolean; input?: { path: string; [key: string]: unknown } } | undefined;
  };
  const read = (path: string) => emit("tool_call", { toolName: "read", input: { path, limit: 8 } });
  await emit("before_agent_start", { prompt: "Discover routers", systemPrompt: "base" });
  assert.deepEqual(calls, [], "Router discovery must not load any member body or invoke AK");
  assert.equal((await read(`skill://${secondId}/references/deep/selected.md`))?.block, true, "Duplicate UUID without invocation scope fails closed");
  assert.equal((await read(`skill://${removedId}/SKILL.md`))?.block, true, "Missing UUID never falls back to a native command name");
  assert.equal((await read("skill:///SKILL.md"))?.block, true);
  assert.equal((await read(`skill://${firstId}/%2e%2e/outside.md`))?.block, true, "Traversal is rejected before activation");
  assert.deepEqual(calls, []);
  await emit("input", { source: "rpc", text: "/skill:selected-first" });
  assert.deepEqual(calls.map(item => item.id), [first.id], "Selecting one member does not load its linked members");
  const result = await read(`skill://${secondId}/references/deep/selected.md:2-4`);
  assert.equal(result?.input?.path, join(root, "snapshots/selected", second.id!, "references/deep/selected.md") + ":2-4");
  assert.equal(result?.input?.limit, 8);
  const nativeBytes = await readFile(result!.input!.path.slice(0, -4), "utf8");
  assert.equal(nativeBytes, resource);
  assert.equal(hash(nativeBytes), hash(resource), "Native read receives the exact selected member bytes");
  assert.deepEqual(calls.map(item => item.sourceId), ["selected", "selected"]);
  const snapshot = "s_" + hash(bodies.get(second)!);
  assert.equal((await read(`skill://${secondId}/references/deep/selected.md?snapshot=${snapshot}:raw`))?.input?.path.endsWith("selected.md:raw"), true);
  assert.equal((await read(`skill://${secondId}/references/deep/selected.md?snapshot=wrong:raw`))?.block, true);
  for (const target of ["../outside.md", "%2e%2e/outside.md", "%2Fetc/passwd", "/etc/passwd", "C%3A/windows", "references/%ZZ", "references/%00bad", "references%5c..%5coutside.md", "references%3Fbad", "escape.md", "missing.md"]) {
    assert.equal((await read(`skill://${firstId}/${target}`))?.block, true, target);
  }
  assert.equal((await read(`skill://${removedId}/SKILL.md`))?.block, true, "UUID-shaped host name cannot substitute for a missing record in the current scope");
  await rm(join(root, "snapshots/selected", second.id!, "references/deep/selected.md"));
  assert.equal((await read(`skill://${secondId}/references/deep/selected.md`))?.block, true, "Removed resource cannot fall back to native filesystem read");
  records = records.filter(item => item !== second);
  await host.refresh();
  await emit("input", { source: "rpc", text: "/skill:selected-first" });
  assert.equal((await read(`skill://${secondId}/SKILL.md`))?.block, true, "Removed member cannot fall back to same-name record from another source");
  assert.ok(calls.every(item => item.sourceId === "selected"));
  console.log("Native member read contracts passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
