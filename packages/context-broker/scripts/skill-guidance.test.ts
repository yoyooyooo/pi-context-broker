import { createLibrarySelection } from "../src/library-selection";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { currentNotionFixture } from "./fixtures/current-notion-source";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const runtime = await currentNotionFixture();
const packageRoot = join(runtime.root, "src/builtin-skills");
const packageEntry = join(packageRoot, "ntn-skills-maintain/SKILL.md");
const syncEntry = join(packageRoot, "ntn-skills-sync/SKILL.md");
const privatePackageBody = "# Packaged maintenance body must not be preloaded.\n";
const privateSyncBody = "# Packaged sync body must not be preloaded.\n";
await mkdir(join(packageRoot, "ntn-skills"), { recursive: true });
await mkdir(join(packageRoot, "ntn-skills-maintain"), { recursive: true });
await mkdir(join(packageRoot, "ntn-skills-sync"), { recursive: true });
await writeFile(join(packageRoot, "ntn-skills/SKILL.md"), "# Packaged consumption body.\n");
await writeFile(packageEntry, privatePackageBody);
await writeFile(syncEntry, privateSyncBody);
const { buildCliGuidance, buildInjectedPayload, installSkillGuidance } = await import(pathToFileURL(join(runtime.root, "src/index.ts")).href);
const { installHostSkills } = await import(pathToFileURL(join(runtime.root, "src/host-skills.ts")).href);
const { hostCliScope } = await import(pathToFileURL(join(runtime.root, "src/host-command.ts")).href);
import { createPiHostAdapter } from "../src/pi-host-adapter";
import type { AgentMessage, ConfigFile, ContextResult, ExtensionAPI, ExtensionContext, NativeSkillGraphDefinition, SkillRecord } from "../src/types";

const full = ["read", "skill_search", "skill_prepare", "skill_graph", "bash"];
const config: ConfigFile = { sources: [
  { id: "alpha", type: "notion", library: "00000000-0000-4000-8000-000000000101" },
  { id: "beta", type: "notion", library: "00000000-0000-4000-8000-000000000102" },
  { id: "disabled", type: "notion", enabled: false },
  { id: "local", type: "filesystem", roots: [] },
] };
const text = (tools?: readonly string[]) => String(buildCliGuidance(config, tools).content);
const guidanceText = (messages: AgentMessage[]) => String(messages.find(message => message.customType === "ntn-skills-guidance")?.content);

// Bound routing prose independently of the required host-local locators. The
// public paired runner deliberately puts TMPDIR under a potentially long path.
// Check each exact locator occurs once before excluding only its encoded bytes.
const routingBytes = (guidance: string): number => {
  let bytes = Buffer.byteLength(guidance);
  for (const entry of [packageEntry, syncEntry]) {
    const locator = JSON.stringify(entry);
    expect(guidance.split(locator)).toHaveLength(2);
    bytes -= Buffer.byteLength(locator);
  }
  return bytes;
};

test("native Pi guidance is a bounded routing contract, not a duplicated CLI tutorial", () => {
  const guidance = text(["read", "notion_list", "notion_use", "bash"]);
  expect(routingBytes(guidance)).toBeLessThanOrEqual(1500);
  expect(guidance).not.toContain("Zero tool calls/body reads");
  expect(guidance).toContain("refresh:true checks latest main; pins fixed");
  expect(guidance).toContain("refresh:true adopts latest on request");
  expect(guidance).toContain("Reuse complete content");
  expect(guidance).toContain("Named Notion existence/availability: query:name,refresh:true; metadata only");
  expect(guidance).toContain("Also after writes");
  expect(guidance).toContain("keeping pins");
  expect(guidance).toContain("Check freshness");
  expect(guidance).toContain("read(path) inspects");
  expect(guidance).toContain("notion_use(ref) applies with Requires");
  for (const boundary of ["candidates", "Local @Skills", "availability", "read", "notion_use", "Requires", "Members", "snapshot", "sr:", "authorize", "Code mode"])
    expect(guidance).toContain(boundary);
  for (const extra of ["<cli", "--query", "maxNodes", "/configured", "next_cursor", "tool_search", "doctor", "notion-skill-owner"])
    expect(guidance).not.toContain(extra);
  expect((guidance.match(/<ntn-skills-guidance>/g) ?? [])).toHaveLength(1);
});

test("native capability fallback alone adds exact CLI scope without teaching unavailable operations", () => {
  const baseline = text(["read", "notion_list", "notion_use", "bash"]);
  const partial = text(["notion_list", "notion_use", "bash"]);
  expect(partial).toContain("ntn-skills.mjs");
  expect(partial).toContain("00000000-0000-4000-8000-000000000102");
  expect(partial).not.toContain("/must-not-appear");
  expect(partial).toContain("read REF");
  expect(baseline).not.toContain("/configured");
  expect(text(["notion_list", "notion_use"])).toContain("unavailable");
  expect(text(["notion_list", "notion_use"])).not.toContain("<cli");
});

test("explicit Skill use keeps selection separate from read-only execution limits", () => {
  const native = text(["read", "notion_list", "notion_use", "bash"]);
  expect(native).toContain("Use/follow even read-only: notion_use(ref) applies with Requires");
  expect(native).toContain("Inspection never activates");
  expect(native).toContain("Loading authorizes no commands/writes/delegation");
  for (const tools of [undefined, full, ["read", "skill_search", "bash"]]) {
    const guidance = text(tools);
    expect(guidance).toContain("read-only");
    expect(guidance).toContain("scripts or writes");
    expect(guidance).toContain("without adoption");
    expect(guidance).not.toContain("For inspection or explanation, use native read");
  }
  const unavailable = text(["read", "notion_list"]);
  expect(unavailable).not.toContain("notion_use(ref)");
  expect(unavailable).toContain("Inspect only; adoption unavailable");
});

test("read-only use and inspect-only requests remain user intent, without automatic adoption", async () => {
  for (const prompt of [
    "Use the selected Skill to answer this question; do not run scripts or change pages.",
    "Just view its newest instructions without adopting them.",
  ]) {
    const h = guidanceHarness();
    h.tools(["read", "notion_list", "notion_use", "bash"]);
    const user: AgentMessage = { role: "user", content: prompt };
    const history = [user];
    const projected = await h.project("context_with_system", history);
    expect(projected[0]).toBe(user);
    expect(history).toEqual([user]);
    expect(projected).toHaveLength(2);
    expect(guidanceText(projected)).toContain("Use/follow even read-only");
    expect(guidanceText(projected)).toContain("Inspection never activates");
    expect(await h.project("context_with_system", projected)).toBe(projected);
  }
});

test("an existing conversation replaces old guidance before a named availability question without rewriting history", async () => {
  const h = guidanceHarness();
  h.tools(["read", "notion_list", "notion_use", "bash"]);
  const oldGuidance: AgentMessage = { role: "custom", customType: "ntn-skills-guidance", content: "Old discovery instructions.", timestamp: 1 };
  const local: AgentMessage = { role: "custom", customType: "local-context", content: "Use the explicitly chosen local source." };
  const body: AgentMessage = { role: "custom", customType: "selected-content", content: "Previously selected complete root and Requires instructions." };
  const question: AgentMessage = { role: "user", content: "Do you have that Skill available?" };
  const history = [local, oldGuidance, body, question], original = structuredClone(history);
  const projected = await h.project("context_with_system", history);
  expect(history).toEqual(original);
  for (const message of [local, body, question]) expect(projected).toContain(message);
  expect(projected).not.toContain(oldGuidance);
  expect(projected.filter(message => message.customType === "ntn-skills-guidance")).toHaveLength(1);
  expect(guidanceText(projected)).toContain("Honor explicit source and prior choice");
  expect(guidanceText(projected)).toContain("Named Notion existence/availability: query:name,refresh:true; metadata only");
  expect(guidanceText(projected)).toContain("failed/partial/offline is not absence");
  expect(await h.project("context_with_system", projected)).toBe(projected);
});

test("all host branches default maintenance and sync to the paired package independently of the write source", () => {
  for (const tools of [undefined, full, ["read", "notion_list", "notion_use", "bash"], ["read", "notion_list", "notion_use"], ["read", "skill_search"]]) {
    const routed = text(tools);
    expect(routed).toContain("Default product maintenance/sync");
    for (const entry of [packageEntry, syncEntry]) expect(routed).toContain(`read(${JSON.stringify(entry)})`);
    expect(routed).toContain("no Notion copy needed");
    expect(routed).toContain("Select write source separately");
    expect(routed).toContain("Explicit Notion workflow: read exact ref in chosen source");
    expect(routed).toContain("Pending/failed: no builtin fallback");
    expect(routed).toContain("Edited item: inspect only.");
    for (const forbidden of ["ntn-skills-maintain's exact ref", "absent/pending:", "Builtins: explicit offline/bootstrap only", "/configured", "/must-not-appear", privatePackageBody.trim(), privateSyncBody.trim()])
      expect(routed).not.toContain(forbidden);
  }
  const native = text(["read", "notion_list", "notion_use", "bash"]);
  expect(native).toContain("To apply: notion_use(ref), same ref + Requires");
  expect(native).toContain("Business Skills: equal same-name local/Notion fits: clarify");
  expect(native).not.toContain("ctl builtin read");
});

test("explicit Notion workflow adoption advertises only an available closure-loading route", () => {
  const inspect = text(["read", "notion_list"]);
  expect(inspect).toContain("Inspect only; adoption unavailable");
  expect(inspect).not.toContain("notion_use(ref)");
  expect(inspect).not.toContain("CLI use EXACT_REF");
  const cli = text(["read", "notion_list", "bash"]);
  expect(cli).toContain("To apply: CLI use EXACT_REF");
  expect(cli).toContain("use REF --json");
  expect(cli).toContain("list --query TEXT --json");
  expect(cli).toContain("match the selected record identity");
  expect(cli).toContain("same ref + Requires");
  expect(cli).not.toContain("notion_use(ref)");
  expect(text(full)).toContain("To apply: skill_prepare purpose use");
  const generic = text(["read", "skill_search", "bash"]);
  expect(generic).toContain("To apply: CLI use EXACT_REF");
  expect(generic).toContain("<use-args>");
  expect(generic).toContain("<list-args>");
  expect(text(["read", "skill_search"])).toContain("Inspect only; adoption unavailable");
});

test("workflow guidance preserves native capability limits and the explicit no-source bootstrap route", () => {
  expect(text(["notion_list", "notion_use", "bash"])).toContain("Explicit Notion workflow: CLI read");
  expect(text(["read", "notion_use", "bash"])).toContain("CLI list there if needed");
  expect(text(["read", "notion_use"])).toContain("discovery unavailable");
  expect(text(["notion_list", "notion_use"])).not.toContain("Explicit Notion workflow:");
  for (const tools of [["bash"], ["notion_list", "notion_use", "bash"]]) {
    const routed = text(tools);
    expect(routed).toContain("exact ref in chosen source");
    for (const name of ["ntn-skills-maintain", "ntn-skills-sync"])
      expect(routed).toContain(JSON.stringify([...hostCliScope().command, "ctl", "builtin", "read", `notion/${name}`, "--json"]));
    expect(routed).not.toContain(packageEntry);
    expect(routed).not.toContain(syncEntry);
  }
  for (const tools of [undefined, ["bash"]]) {
    const bootstrap = String(buildCliGuidance({ sources: [] }, tools).content);
    expect(bootstrap).toContain("bootstrap");
    expect(bootstrap).toContain("offline");
    expect(bootstrap).toContain("ctl builtin read notion/ntn-skills-maintain");
    expect(bootstrap).toContain("ctl builtin read notion/ntn-skills-sync");
    expect(bootstrap).not.toContain("ntn-skills-maintain's exact ref");
  }
});

test("deferred native management exposes only exact enabled source IDs when a CLI must be located", async () => {
  const normal = ["read", "notion_list", "notion_use", "bash"];
  const lazy = [...normal, "tool_search"];
  const native = [...normal, "notion_ctl"];
  const hidden = text(normal), discoverable = text(lazy), discovered = text(native);
  expect(hidden).not.toContain("cli_source");
  expect(discoverable).toContain("tool_search for notion_ctl, then its cli_source");
  expect(discoverable).not.toContain("notion_ctl working_set");
  expect(discovered).toContain("notion_ctl cli_source");
  expect(discovered).not.toContain("tool_search");
  for (const routed of [discoverable, discovered]) {
    expect(routed).toContain('["alpha","beta"]');
    expect(routed).toContain("Choose explicitly");
    expect(routed).toContain("use returned command/scope, never a global CLI");
    expect(routed).toContain("No execution or authorization");
    for (const forbidden of ["/configured", "00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102", "disabled", "must-not-appear", '"local"'])
      expect(routed).not.toContain(forbidden);
  }
  expect(routingBytes(hidden)).toBeLessThanOrEqual(1500);
  expect(routingBytes(discoverable)).toBeLessThanOrEqual(1500);
  expect(routingBytes(discovered)).toBeLessThanOrEqual(1800);
  for (const tools of [lazy, native]) expect(text(tools.filter(tool => tool !== "bash"))).not.toContain("cli_source");
  expect(String(buildCliGuidance({ sources: [] }, lazy).content)).not.toContain("cli_source");
  const h = await graphHarness();
  h.tools(native);
  const result = resultJson(await h.invoke({ cli_source: "beta" }));
  expect(result).toEqual({ kind: "host_cli_scope", sourceId: "beta", command: hostCliScope([config.sources![1]!]).command,
    library: "00000000-0000-4000-8000-000000000102", executed: false,
    execution: { default_cli_timeout_ms: 600_000, guidance: expect.any(String) } });
  expect(h.counts()).toEqual({ graphReads: 0, loads: 0, appends: 0 });
});

test("source-ID routing follows lazy discovery, activation and missing shell without changing history", async () => {
  const h = guidanceHarness();
  const original: AgentMessage[] = [{ role: "user", content: "Maintain the chosen source, but do not guess a global CLI." }];
  h.tools(["read", "notion_list", "notion_use", "bash"]);
  const normal = await h.project("context_with_system", original);
  expect(guidanceText(normal)).not.toContain("cli_source");
  h.tools(["read", "notion_list", "notion_use", "bash", "tool_search"]);
  const lazy = await h.project("context_with_system", normal);
  expect(guidanceText(lazy)).toContain("tool_search for notion_ctl, then its cli_source");
  expect(lazy.filter(message => message.customType === "ntn-skills-guidance")).toHaveLength(1);
  expect(await h.project("context_with_system", lazy)).toBe(lazy);
  h.tools(["read", "notion_list", "notion_use", "notion_ctl", "bash", "tool_search"]);
  const discovered = await h.project("context_with_system", lazy);
  expect(guidanceText(discovered)).toContain('["alpha","beta"]');
  expect(guidanceText(discovered)).toContain("CLI management: notion_ctl cli_source");
  expect(guidanceText(discovered)).not.toContain("tool_search");
  expect(discovered.filter(message => message.customType === "ntn-skills-guidance")).toHaveLength(1);
  expect(await h.project("context_with_system", discovered)).toBe(discovered);
  h.tools(["read", "notion_list", "notion_use", "notion_ctl", "tool_search"]);
  const noShell = await h.project("context_with_system", discovered);
  expect(guidanceText(noShell)).not.toContain("cli_source");
  expect(noShell[0]).toBe(original[0]);
  expect(guidanceText(normal)).not.toContain("cli_source");
  expect(guidanceText(lazy)).toContain("tool_search for notion_ctl");
});

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
  expect(shell).toContain("ntn-skills.mjs");
  expect(shell).toContain("<list-args>"); expect(shell).toContain("<read-args>");
  expect(shell).toContain("00000000-0000-4000-8000-000000000102"); expect(shell).not.toContain("cli_source");
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

test("cold and offline Pi guidance exposes both paired package entries without preloading them", async () => {
  for (const offline of [false, true]) {
    const settings: ConfigFile = { sources: [{ id: "selected", type: "notion", library: "00000000-0000-4000-8000-000000000103",
      discovery: { offline }, activation: { offline } }] };
    const h = guidanceHarness("pi", true, settings);
    h.tools(["read", "notion_list", "notion_use", "bash"]);
    const before = await h.handlers.get("before_agent_start")?.({} as never, {}) as { message?: AgentMessage } | undefined;
    expect(before?.message?.customType).toBe("ntn-skills-guidance");
    const message = String(before?.message?.content);
    expect(message).toContain(JSON.stringify(packageEntry));
    expect(message).toContain(JSON.stringify(syncEntry));
    expect(message).toContain("Default product maintenance/sync");
    expect(message).toContain("Pending/failed: no builtin fallback");
    expect(message).toContain("never search other installations");
    expect(message).toContain("exact ref in chosen source");
    expect(message).not.toContain(privatePackageBody.trim());
    expect(message).not.toContain(privateSyncBody.trim());
    expect(message).not.toContain("ctl builtin read");
    expect(message).not.toContain("00000000-0000-4000-8000-000000000103");
    const history = [{ role: "user", content: "Explain packaged maintenance instructions offline." }];
    const projected = await h.project("context_with_system", history);
    expect(guidanceText(projected)).toBe(message);
    expect(await h.project("context_with_system", projected)).toBe(projected);
    expect(history).toHaveLength(1);
  }
});

test("paired package guidance respects the active read capability", async () => {
  const h = guidanceHarness();
  h.tools(["read", "notion_list", "notion_use"]);
  const native = await h.project("context_with_system", []);
  expect(guidanceText(native)).toContain(JSON.stringify(packageEntry));
  expect(guidanceText(native)).toContain(JSON.stringify(syncEntry));
  h.tools(["notion_list", "notion_use"]);
  const unavailable = await h.project("context_with_system", native);
  expect(guidanceText(unavailable)).not.toContain(packageEntry);
  expect(guidanceText(unavailable)).not.toContain(syncEntry);
  expect(guidanceText(unavailable)).toContain("Packaged help requires read or bash");
  h.tools(["notion_list", "notion_use", "bash"]);
  const cli = await h.project("context_with_system", unavailable);
  expect(guidanceText(cli)).toContain("ntn-skills.mjs");
  expect(guidanceText(cli)).toContain('"ctl","builtin","read","notion/ntn-skills-maintain","--json"');
  expect(guidanceText(cli)).toContain('"ctl","builtin","read","notion/ntn-skills-sync","--json"');
  expect(guidanceText(cli)).toContain("Default product maintenance/sync");
  expect(guidanceText(cli)).not.toContain(packageEntry);
  expect(guidanceText(cli)).not.toContain(privatePackageBody.trim());
  expect(guidanceText(cli)).not.toContain(privateSyncBody.trim());
});

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
  expect(guidanceText(fallback)).toContain("ntn-skills.mjs");
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
  expect(guidance).toContain("beyond the default View");
  expect(guidance).toContain("Editor flags grant no permissions");
  expect(guidance).toContain("Local @Skills keep native availability");
  expect(guidance).toContain("Honor explicit source and prior choice");
  expect(guidance).toContain("Business Skills: equal same-name local/Notion fits: clarify; storage gives no priority");
  expect(guidance).toContain("Clear fit/equivalent copies: no question");
  expect(guidance).toContain("Loading authorizes no commands/writes/delegation");
  expect(guidance).toContain("read(path) inspects.");
  expect(guidance).toContain("Inspection never activates.");
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
  const table = { database_id: "00000000-0000-4000-8000-000000000201", data_source_id: "00000000-0000-4000-8000-000000000202", property_ids: {} };
  const libraries = createLibrarySelection(settings, async options => ({ version: 2, library_id: options.library ?? "00000000-0000-4000-8000-000000000101", operation_id: "fixture",
    skills: table, files: table, records: table, sources: table }));
  const host = await installHostSkills(api, { config: settings, librarySelection: libraries,
    getRecords: async () => ({ records: [], failures: [] }),
    loadRecord: async () => { loads++; throw new Error("No body loads permitted"); },
    sessionGraph: () => { graphReads++; return { portable: true }; },
  }, createPiHostAdapter(api));
  await host.refresh();
  if (!graphTool) throw new Error("notion_ctl must be registered");
  const ctx: ExtensionContext = { cwd: "/unused-guidance-test", hasUI: false };
  const invoke = (input: Record<string, unknown>, signal?: AbortSignal) => graphTool!.execute("controlled", input, signal, undefined, ctx);
  return { invoke, tools: (names: string[]) => { active = names; }, counts: () => ({ graphReads, loads, appends }) };
}
const resultJson = (result: Awaited<ReturnType<Awaited<ReturnType<typeof graphHarness>>["invoke"]>>) => JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join(""));

test("cli_source returns only the requested host-local scope without loading, execution or graph mutation", async () => {
  const h = await graphHarness();
  const result = await h.invoke({ cli_source: "beta" });
  expect(resultJson(result)).toEqual({ kind: "host_cli_scope", sourceId: "beta", command: hostCliScope([config.sources![1]!]).command,
    library: "00000000-0000-4000-8000-000000000102", executed: false,
    execution: { default_cli_timeout_ms: 600_000, guidance: expect.any(String) } });
  expect(result.details).toEqual(resultJson(result));
  expect(h.counts()).toEqual({ graphReads: 0, loads: 0, appends: 0 });
  expect(resultJson(await h.invoke({}))).toEqual({ portable: true });
  expect(resultJson(await h.invoke({ refs: [] }))).toEqual({ graph: { portable: true }, references: [] });
});

test("explicit CLI discovery carries execution budget and durable waiting guidance without lengthening routing prompts", async () => {
  const h = await graphHarness();
  const result = resultJson(await h.invoke({ cli_source: "alpha" }));
  expect(result.command).toEqual(hostCliScope([config.sources![0]!]).command);
  expect(result.sourceId).toBe("alpha"); expect(result.library).toBe("00000000-0000-4000-8000-000000000101");
  expect(result.execution.default_cli_timeout_ms).toBe(600_000);
  for (const requirement of ["600 seconds", "--timeout is in milliseconds", "startup and completion margin",
    "persistent background job", "original Store and credential scope", "same process's terminal result",
    "polling timeout is not completion", "do not kill or repeat the write"])
    expect(result.execution.guidance).toContain(requirement);
  for (const tools of [["read", "notion_list", "notion_use", "tool_search", "bash"],
    ["read", "notion_list", "notion_use", "notion_ctl", "bash"]]) {
    expect(text(tools)).not.toContain("default_cli_timeout_ms");
    expect(text(tools)).not.toContain("600 seconds");
    expect(text(tools)).not.toContain("persistent background job");
  }
  expect(result.executed).toBe(false);
  expect(h.counts()).toEqual({ graphReads: 0, loads: 0, appends: 0 });
});

test("default source command resolves the actual bundle rather than a global ntn-skills binary", async () => {
  const h = await graphHarness({ sources: [{ id: "default", type: "notion", library: "00000000-0000-4000-8000-000000000104" }] });
  const result = resultJson(await h.invoke({ cli_source: "default" }));
  expect(result.command).toHaveLength(2); expect(result.command[0]).not.toBe("ntn-skills");
  expect(result.command[1]).toMatch(/ntn-skills\.mjs$/); expect(existsSync(result.command[1])).toBe(true);
  expect(result.library).toBe("00000000-0000-4000-8000-000000000104"); expect(result.executed).toBe(false);
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
  const ambiguous = await graphHarness({ sources: [{ id: "same", type: "notion" }, { id: "same", type: "notion" }] });
  await expect(ambiguous.invoke({ cli_source: "same" })).rejects.toThrow("HOST_SOURCE_AMBIGUOUS");
  const cancelled = new AbortController(); cancelled.abort();
  await expect(h.invoke({ cli_source: "beta" }, cancelled.signal)).rejects.toThrow();
  expect(h.counts()).toEqual({ graphReads: 0, loads: 0, appends: 0 });
});
