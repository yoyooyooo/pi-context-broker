import { expect, test } from "bun:test";
import { installHostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { buildCliGuidance } from "../src/index";
import type { ExtensionAPI, NativeSkillSearchDefinition } from "../src/types";

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
