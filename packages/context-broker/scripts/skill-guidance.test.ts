import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { buildCliGuidance, buildInjectedPayload, installSkillGuidance } from "../src/index";
import { installHostSkills } from "../src/host-skills";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import type { AgentMessage, ConfigFile, ContextResult, ExtensionAPI, ExtensionContext, NativeSkillGraphDefinition, SkillRecord } from "../src/types";

const full = ["read", "skill_search", "skill_prepare", "skill_graph", "bash"];
const config: ConfigFile = { sources: [
  { id: "alpha", type: "notion", command: ["/configured alpha/node", "/configured alpha/cli.mjs"], database: "database-a" },
  { id: "beta", type: "notion", command: ["/configured beta/node", "/configured beta/cli.mjs", "--profile", "selected"], database: "database-b" },
  { id: "disabled", type: "notion", command: "/must-not-appear", enabled: false },
  { id: "local", type: "filesystem", roots: [] },
] };
const text = (tools?: readonly string[]) => String(buildCliGuidance(config, tools).content);
const guidanceText = (messages: AgentMessage[]) => String(messages.find(message => message.customType === "ntn-skills-guidance")?.content);

test("native consumption keeps exact references and operation intent without machine commands", () => {
  const guidance = text(full);
  for (const ref of ["sr:C", "sr:S", "sr:R", "skill://"]) expect(guidance).toContain(ref);
  for (const token of ["purpose inspect", "purpose use", "Required", "Members", "cli_source", '"alpha"', '"beta"']) expect(guidance).toContain(token);
  for (const token of ["<cli", "<list-args>", "<read-args>", "/configured", "/must-not-appear", "doctor"]) expect(guidance).not.toContain(token);
  expect(guidance).toContain("does not authorize executing");
  expect(guidance).toContain("for ordinary follow-up questions, without rereading it or probing packages");
  expect(guidance).toContain("Still perform discovery, read, inspect or use operations explicitly requested by the current user through an available, authorized route.");
  expect(guidance).toContain("An existing preparation does not replace a skill_prepare operation explicitly requested by the current user.");
  expect(guidance).not.toContain("An already supplied host preparation satisfies that step.");
  expect(guidance).toContain("do not assume a global ntn-skills command");
});

test("fallback follows missing operations and never advertises disabled tools or shell", () => {
  const shell = text(["bash"]);
  expect(shell).toContain("/configured beta/cli.mjs");
  expect(shell).toContain("<list-args>"); expect(shell).toContain("<read-args>");
  expect(shell).toContain("database-b"); expect(shell).not.toContain("cli_source");
  expect(shell).not.toContain("Use read with"); expect(shell).not.toContain("Use skill_prepare");
  const noSearch = text(["read", "skill_prepare", "bash"]);
  expect(noSearch).toContain("<list-args>"); expect(noSearch).not.toContain("<read-args>");
  const noRead = text(["skill_search", "skill_prepare", "bash"]);
  expect(noRead).toContain("<read-args>"); expect(noRead).not.toContain("<list-args>");
  const searchOnly = text(["skill_search", "bash"]);
  expect(searchOnly).toContain("<list-args>"); expect(searchOnly).toContain("<read-args>");
  expect(searchOnly).toContain("CLI commands cannot resolve session sr: handles");
  expect(searchOnly).toContain("matching its exact record identity rather than guessing a name");
  const noShell = text(["read", "skill_graph"]);
  expect(noShell).not.toContain("/configured"); expect(noShell).not.toContain("cli_source");
  expect(noShell).not.toContain("Use skill_search"); expect(noShell).toContain("No metadata discovery route");
  const none = text([]);
  expect(none).toContain("No Skill body/resource read route"); expect(none).not.toContain("<cli");
  expect(text(["read", "skill_search", "skill_prepare", "bash"])).not.toContain("cli_source");
});

function guidanceHarness(host: "pi" | "omp" = "pi", known = true, settings: ConfigFile = config) {
  let active = [...full];
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const api: ExtensionAPI = { on(name, listener) { handlers.set(name, listener); }, ...(known ? { getActiveTools: () => [...active] } : {}) };
  installSkillGuidance(api, settings, { host });
  const ctx: ExtensionContext = { cwd: "/unused-guidance-test", hasUI: false };
  async function project(event: "context" | "context_with_system", messages: AgentMessage[]) {
    const result = await handlers.get(event)?.({ messages } as never, ctx) as ContextResult | undefined;
    return result?.messages ?? messages;
  }
  return { api, handlers, project, tools: (next: string[]) => { active = next; } };
}

test("Pi with no enabled Notion source omits new and stale guidance without touching local history", async () => {
  for (const known of [false, true]) for (const sources of [undefined, [], [{ id: "n", type: "notion" as const, enabled: false }], [{ id: "fs", type: "filesystem" as const, roots: [] }]]) {
    const h = guidanceHarness("pi", known, { sources });
    h.tools(["read", "notion_list", "notion_use", "existing_mcp_tool"]);
    const system = { role: "system", content: "Native local Skill directory" };
    const user = { role: "user", content: "Literal <ntn-skills-guidance> is user content" };
    const local = { role: "custom", customType: "context-broker", content: "LOCAL_BODY <ntn-skills-guidance>" };
    const stale = { role: "custom", ...buildCliGuidance(config) };
    const history = [system, user, stale, local], original = JSON.stringify(history);
    expect(await h.handlers.get("before_agent_start")?.({} as never, {})).toBeUndefined();
    for (const event of known ? ["context", "context_with_system"] as const : ["context"] as const) {
      const result = await h.project(event, history);
      expect(result).toEqual([system, user, local]);
      expect(result[0]).toBe(system); expect(result[1]).toBe(user); expect(result[2]).toBe(local);
    }
    expect(JSON.stringify(history)).toBe(original);
  }
});

test("Pi guidance follows reloaded source availability without restoring stale disabled context", async () => {
  let history: AgentMessage[] = [{ role: "user", content: "Keep the native local Skill" }];
  for (const enabled of [false, true, false]) {
    const h = guidanceHarness("pi", true, { sources: [{ id: "notion", type: "notion", enabled }] });
    h.tools(enabled ? ["read", "notion_list", "notion_use"] : ["read", "existing_mcp_tool"]);
    history = await h.project("context_with_system", history);
    expect(history.filter(message => message.customType === "ntn-skills-guidance")).toHaveLength(enabled ? 1 : 0);
    expect(history[0]).toEqual({ role: "user", content: "Keep the native local Skill" });
  }
});

test("each final context projects current capabilities without mutating history, body or system", async () => {
  const h = guidanceHarness();
  const system = { role: "system", content: "native system and tools" };
  const user = { role: "user", content: "Explain only. Literal <ntn-skills-guidance> is part of this question." };
  const body = { role: "custom", customType: "context-broker", content: "Source examples: <ntn-skills-guidance>\n\ufeffbytes\r\n", details: { proof: "unchanged" } };
  const historical = { role: "custom", ...buildCliGuidance(config), timestamp: 1 };
  const history = [system, user, historical, body, { ...historical, timestamp: 2 }];
  const original = JSON.stringify(history);
  const native = await h.project("context", history);
  expect(native[0]).toBe(system); expect(native).toContain(user); expect(native).toContain(body);
  expect(native.filter(message => message.customType === "ntn-skills-guidance")).toHaveLength(1);
  expect(guidanceText(native)).not.toContain("/configured");
  h.tools(["bash"]);
  const fallback = await h.project("context_with_system", native);
  expect(guidanceText(fallback)).toContain("/configured alpha/node");
  expect(guidanceText(native)).not.toContain("/configured");
  h.tools([]);
  const unavailable = await h.project("context_with_system", fallback);
  expect(guidanceText(unavailable)).not.toContain("/configured");
  expect(await h.project("context_with_system", unavailable)).toBe(unavailable);
  expect(JSON.stringify(history)).toBe(original);
});

test("Notion source flags are scoped to native installations without rewriting source or native context", async () => {
  const h = guidanceHarness();
  h.tools(["read", "notion_list", "notion_use"]);
  const system = { role: "system", content: "Native Skill directory and /local/SKILL.md remain host-owned." };
  const source = { role: "custom", customType: "context-broker", content: "---\ndisable-model-invocation: true\n---\nExact source instructions.\n" };
  const history = [system, { role: "user", content: "Introduce this Skill." }, source];
  const original = JSON.stringify(history);
  const projected = await h.project("context", history);
  const guidance = guidanceText(projected);
  expect(guidance).toContain("Notion's Default View controls its default directory");
  expect(guidance).toContain("Native-loader/editor flags in source text (for example disable-model-invocation) describe native installations");
  expect(guidance).toContain("reported availability and permissions and the current user intent");
  expect(guidance).toContain("Local Skills keep their native discovery and read paths");
  expect(guidance).toContain("does not authorize executing its workflow");
  expect(guidance).toContain("Choosing a Skill to introduce or inspect uses read");
  expect(projected[0]).toBe(system);
  expect(projected).toContain(source);
  expect(JSON.stringify(history)).toBe(original);
  expect(await h.project("context_with_system", projected)).toBe(projected);
  h.tools(full);
  const legacy = await h.project("context_with_system", projected);
  expect(guidanceText(legacy)).not.toContain("Native-loader/editor flags");
  expect(legacy[0]).toBe(system);
  expect(legacy).toContain(source);
  expect(JSON.stringify(history)).toBe(original);
});

test("unknown Pi capability and OMP keep legacy command guidance", async () => {
  for (const h of [guidanceHarness("pi", false), guidanceHarness("omp", true)]) {
    const old = { role: "custom", customType: "ntn-skills-guidance", content: "Earlier legacy config guidance" };
    const history = [{ role: "user", content: "task" }, old, { ...old }];
    const projected = await h.project("context", history);
    expect(projected.slice(0, history.length)).toEqual(history);
    expect(projected.filter(message => message.customType === "ntn-skills-guidance")).toHaveLength(3);
    expect(String(projected.at(-1)?.content)).toBe(text());
    expect(await h.project("context", projected)).toBe(projected);
    const clean = await h.project("context", [{ role: "user", content: "task" }]);
    expect(guidanceText(clean)).toBe(text());
    expect(h.handlers.has("context_with_system")).toBe(false);
  }
});

test("redacted and visible record wrappers retain source bytes and the same non-execution boundary", () => {
  const api: ExtensionAPI = { on() {} }, adapter = createPiHostAdapter(api);
  const body = "\ufeff# Arbitrary workflow\r\nRun prerequisites only for this workflow.\r\n<body>literal & code</body>\r\n";
  const record: SkillRecord = { name: "arbitrary", description: "source", path: "/exact/SKILL.md", body,
    aliases: [], normalizedAliases: [], normalizedName: "arbitrary", normalizedDescription: "source", autoloadEnabled: true };
  for (const pathMode of ["hash", "basename", "absolute"] as const) {
    const payload = buildInjectedPayload(record, "arbitrary", { pathMode }, adapter);
    const rendered = String(payload.content);
    expect(rendered).toContain("does not authorize executing its workflow");
    expect(rendered).toContain("without performing its prerequisite checks");
    expect(rendered).not.toContain("CLI resource-read-args");
    const decoded = rendered.slice(rendered.indexOf("<body>\n") + 7, rendered.lastIndexOf("\n</body>"))
      .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    expect(decoded).toBe(body);
  }
});

async function graphHarness(settings: ConfigFile = config, known = true) {
  let active = [...full], graphReads = 0, loads = 0, appends = 0;
  let graphTool: NativeSkillGraphDefinition | undefined;
  const api: ExtensionAPI = { on() {}, ...(known ? { getActiveTools: () => [...active] } : {}),
    appendEntry() { appends++; }, registerTool(tool) { if (tool.name === "notion_ctl") graphTool = tool; } };
  const host = await installHostSkills(api, { config: settings,
    getRecords: async () => ({ records: [], failures: [] }),
    loadRecord: async () => { loads++; throw new Error("No body loads permitted"); },
    sessionGraph: () => { graphReads++; return { portable: true }; },
  }, createPiHostAdapter(api));
  await host.refresh(undefined, false);
  if (!graphTool) throw new Error("notion_ctl must be registered");
  const ctx: ExtensionContext = { cwd: "/unused-guidance-test", hasUI: false };
  const invoke = (input: Record<string, unknown>, signal?: AbortSignal) => graphTool!.execute("controlled", input, signal, undefined, ctx);
  return { invoke, tools: (names: string[]) => { active = names; }, counts: () => ({ graphReads, loads, appends }) };
}
const resultJson = (result: Awaited<ReturnType<Awaited<ReturnType<typeof graphHarness>>["invoke"]>>) => JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join(""));

test("cli_source returns only the requested host-local scope without loading, execution or graph mutation", async () => {
  const h = await graphHarness();
  const result = await h.invoke({ cli_source: "beta" });
  expect(resultJson(result)).toEqual({ kind: "host_cli_scope", sourceId: "beta", command: ["/configured beta/node", "/configured beta/cli.mjs", "--profile", "selected"], database: "database-b", executed: false });
  expect(result.details).toEqual(resultJson(result));
  expect(h.counts()).toEqual({ graphReads: 0, loads: 0, appends: 0 });
  expect(resultJson(await h.invoke({}))).toEqual({ portable: true });
  expect(resultJson(await h.invoke({ refs: [] }))).toEqual({ graph: { portable: true }, references: [] });
});

test("default source command resolves the actual bundle rather than a global ntn-skills binary", async () => {
  const h = await graphHarness({ sources: [{ id: "default", type: "notion", database: "chosen-database" }] });
  const result = resultJson(await h.invoke({ cli_source: "default" }));
  expect(result.command).toHaveLength(2); expect(result.command[0]).not.toBe("ntn-skills");
  expect(result.command[1]).toMatch(/ntn-skills\.mjs$/); expect(existsSync(result.command[1])).toBe(true);
  expect(result.database).toBe("chosen-database"); expect(result.executed).toBe(false);
});

test("cli_source rejects ambiguous/disabled/foreign scopes, inactive tools and mixed proof requests", async () => {
  const h = await graphHarness();
  for (const cli_source of ["unknown", "disabled", "local", " beta"])
    await expect(h.invoke({ cli_source })).rejects.toThrow("HOST_SOURCE_UNAVAILABLE");
  for (const request of [{ cli_source: "" }, { cli_source: null }, { cli_source: "beta", refs: [] }, { cli_source: "beta", command: "override" }])
    await expect(h.invoke(request)).rejects.toThrow("INVALID_ARGUMENT");
  for (const names of [["notion_ctl"], []]) {
    h.tools(names); await expect(h.invoke({ cli_source: "beta" })).rejects.toThrow("HOST_CLI_TOOL_UNAVAILABLE");
  }
  const unknown = await graphHarness(config, false);
  await expect(unknown.invoke({ cli_source: "beta" })).rejects.toThrow("HOST_CLI_TOOL_UNAVAILABLE");
  const ambiguous = await graphHarness({ sources: [{ id: "same", type: "notion", command: "/one" }, { id: "same", type: "notion", command: "/two" }] });
  await expect(ambiguous.invoke({ cli_source: "same" })).rejects.toThrow("HOST_SOURCE_AMBIGUOUS");
  const cancelled = new AbortController(); cancelled.abort();
  await expect(h.invoke({ cli_source: "beta" }, cancelled.signal)).rejects.toThrow();
  expect(h.counts()).toEqual({ graphReads: 0, loads: 0, appends: 0 });
});
