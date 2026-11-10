import { expect, test } from "bun:test";
import { installHostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { buildCliGuidance } from "../src/index";
import type { ConfigFile, ExtensionAPI, ExtensionContext, NativeSkillSearchDefinition, PiReadDefinition, SkillRecord } from "../src/types";

async function sourceAvailabilityHost(config: ConfigFile) {
  const registered: Parameters<NonNullable<ExtensionAPI["registerTool"]>>[0][] = [];
  const listeners: Array<(event: never, ctx: ExtensionContext) => unknown> = [];
  let factoryCalls = 0;
  const native: PiReadDefinition = { name: "read", label: "Read", description: "Original local reader",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async execute() { return { content: [{ type: "text", text: "LOCAL_NATIVE_CONTENT" }] }; } };
  let current = { ...native, sourceInfo: { source: "builtin", path: "builtin:read" } };
  const api: ExtensionAPI = { on(name, listener) { if (name === "session_start") listeners.push(listener); },
    registerTool(tool) { registered.push(tool); if (tool.name === "read") current = { ...tool, sourceInfo: { source: "extension", path: "broker:read" } }; },
    getAllTools: () => [current], getActiveTools: () => ["read", "existing_mcp_tool"] };
  const adapter = createPiHostAdapter(api, async () => { factoryCalls++; return () => native; });
  const host = await installHostSkills(api, { config,
    getRecords: async () => ({ records: [], failures: [] }),
    loadRecord: async () => { throw new Error("Registration must not load content"); },
    prepareGraph: async () => { throw new Error("Registration must not prepare content"); },
    sessionGraph: () => ({ scopes: [] }),
  }, adapter);
  for (const listener of listeners) await listener({ type: "session_start" } as never, {});
  return { registered, native, current, factoryCalls, host, active: api.getActiveTools!() };
}

test("Pi without an enabled Notion source preserves native read and other sources without Notion tools", async () => {
  const configs: ConfigFile[] = [
    {}, { sources: [] },
    { sources: [{ id: "notion", type: "notion", enabled: false }] },
    { sources: [{ id: "files", type: "filesystem", roots: [] }] },
    { sources: [{ id: "notion", type: "notion", enabled: false }, { id: "files", type: "filesystem", roots: [] }] },
  ];
  for (const config of configs) {
    const original = JSON.stringify(config), h = await sourceAvailabilityHost(config);
    expect(h.registered).toEqual([]);
    expect(h.factoryCalls).toBe(0);
    expect(h.current.parameters).toBe(h.native.parameters);
    expect(h.current.description).toBe("Original local reader");
    expect(h.active).toEqual(["read", "existing_mcp_tool"]);
    expect(await h.current.execute("local", { path: "SKILL.md" }, undefined, undefined, {}))
      .toEqual({ content: [{ type: "text", text: "LOCAL_NATIVE_CONTENT" }] });
    expect(JSON.stringify(config)).toBe(original);
  }
});

test("Pi extension reinstallation recomputes Notion capabilities across disabled enabled disabled configs", async () => {
  for (const enabled of [false, true, false]) {
    const h = await sourceAvailabilityHost({ sources: [
      { id: "notion", type: "notion", enabled }, { id: "files", type: "filesystem", roots: [] },
    ] });
    expect(h.registered.map(tool => tool.name)).toEqual(enabled ? ["notion_list", "notion_use", "notion_ctl", "read"] : []);
    expect(h.factoryCalls).toBe(enabled ? 1 : 0);
    expect(h.active).toEqual(["read", "existing_mcp_tool"]);
  }
});

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
  expect(guidance).toContain("does not authorize commands, writes or delegation");
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
