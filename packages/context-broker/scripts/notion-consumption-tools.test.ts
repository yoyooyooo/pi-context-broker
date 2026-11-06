import { expect, test } from "bun:test";
import { installHostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { buildCliGuidance } from "../src/index";
import type { ExtensionAPI, NativeSkillSearchDefinition, SkillRecord } from "../src/types";

test("Pi exposes one Notion consumption contract and keeps use outside nested code execution", async () => {
  const registered: Parameters<NonNullable<ExtensionAPI["registerTool"]>>[0][] = [];
  const api: ExtensionAPI = { on() {}, registerTool(tool) { registered.push(tool); } };
  await installHostSkills(api, {
    config: { sources: [{ id: "notion", type: "notion", prefetch: false }] },
    getRecords: async () => ({ records: [], failures: [] }),
    loadRecord: async () => { throw new Error("Metadata must not load bodies"); },
    prepareGraph: async () => { throw new Error("Registration must not prepare instructions"); },
    sessionGraph: () => ({ scopes: [] }),
  }, createPiHostAdapter(api));
  expect(registered.map(tool => tool.name)).toEqual(["notion_list", "notion_use", "notion_ctl"]);
  const use = registered.find(tool => String(tool.name) === "notion_use");
  const ctl = registered.find(tool => String(tool.name) === "notion_ctl");
  const list = registered.find(tool => String(tool.name) === "notion_list");
  expect(list?.description).toContain("Skill refs for read or notion_use");
  expect(list?.description).not.toContain("read references only");
  expect(use).toMatchObject({ exposure: "model-only", defaultActive: true });
  expect(ctl).toMatchObject({ exposure: "deferred", defaultActive: false });
  expect(use?.parameters).toMatchObject({ required: ["ref"], additionalProperties: false });
});

test("Pi guidance uses list, native read and use without exposing machine proof or a second protocol", () => {
  const guidance = String(buildCliGuidance({ sources: [{ id: "notion", type: "notion" }] }, ["read", "notion_list", "notion_use", "bash"]).content);
  expect(guidance).toContain("notion_list");
  expect(guidance).toContain("notion_use");
  expect(guidance).toContain("Requires");
  expect(guidance).toContain("read");
  for (const legacy of ["skill_search", "skill_prepare", "skill_graph", "<cli", "purpose use", "graph_lock"])
    expect(guidance).not.toContain(legacy);
  expect(guidance).toContain("does not authorize executing");
  expect(guidance).toContain("Local Skills");
});

test("an empty metadata page retains incomplete or unknown source coverage", async () => {
  for (const exhaustive of [false, true, undefined]) {
    let list: NativeSkillSearchDefinition | undefined;
    const api: ExtensionAPI = { on() {}, registerTool(tool) { if (tool.name === "notion_list") list = tool; } };
    const host = await installHostSkills(api, {
      config: { sources: [{ id: "notion", type: "notion", prefetch: false }] },
      getRecords: async () => ({ records: [], failures: [], lists: [{ sourceId: "notion", policy: "default", exhaustive }] }),
      loadRecord: async () => { throw new Error("Discovery must not read instructions"); },
    }, createPiHostAdapter(api));
    await host.refresh({});
    if (!list) throw new Error("Expected the registered discovery tool");
    const result = await list.execute("empty", {}, undefined, undefined, {});
    const first = result.content[0];
    if (first?.type !== "text") throw new Error("Expected metadata JSON");
    expect(JSON.parse(first.text)).toMatchObject({ count: 0, total_count: 0, has_more: false, next_cursor: null,
      coverage: { exhaustive: exhaustive ?? null, sources: [{ source: "notion", exhaustive: exhaustive ?? null }] } });
    await expect(list.execute("unknown-source", { source: "foreign" }, undefined, undefined, {})).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
  }
});

test("Notion discovery reports disabled metadata and permission failures independently of native source flags", async () => {
  let list: NativeSkillSearchDefinition | undefined, bodyLoads = 0;
  const records: SkillRecord[] = [true, false].map(enabled => {
    const name = enabled ? "available" : "disabled";
    return { id: name, kind: "skill", name, description: "Owned metadata", enabled,
      ref: `skill://${name}/SKILL.md`, path: `/unused-native-flags/${name}/SKILL.md`,
      body: "---\ndisable-model-invocation: true\n---\nSource instructions.\n",
      source: "notion", sourceId: "notion", sourceScope: "a".repeat(64), defaultDiscovery: true,
      aliases: [], normalizedAliases: [], normalizedName: name, normalizedDescription: "owned metadata", autoloadEnabled: false };
  });
  const api: ExtensionAPI = { on() {}, registerTool(tool) { if (tool.name === "notion_list") list = tool; } };
  const host = await installHostSkills(api, {
    config: { sources: [{ id: "notion", type: "notion", prefetch: false }, { id: "denied", type: "notion", prefetch: false }] },
    getRecords: async () => ({ records, failures: [{ sourceId: "denied", code: "ACCESS_DENIED" }],
      lists: [{ sourceId: "notion", policy: "default", exhaustive: true }] }),
    loadRecord: async () => { bodyLoads++; throw new Error("Metadata must not load bodies"); },
  }, createPiHostAdapter(api));
  await host.refresh({});
  if (!list) throw new Error("Expected the registered discovery tool");
  const result = await list.execute("native-flags", {}, undefined, undefined, {});
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("Expected metadata JSON");
  expect(JSON.parse(first.text)).toMatchObject({ count: 2, coverage: { exhaustive: false },
    records: [{ ref: records[0]!.ref, availability: "available" }, { ref: records[1]!.ref, availability: "disabled" }],
    failures: [{ source: "denied", code: "ACCESS_DENIED" }] });
  expect(first.text).not.toContain("disable-model-invocation");
  expect(first.text).not.toContain("Source instructions");
  expect(bodyLoads).toBe(0);
});
