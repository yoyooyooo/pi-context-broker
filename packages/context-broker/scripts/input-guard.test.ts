import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextBroker, { configuredRules, parseInvocations, matchDiscoveryRecord } from "../src/index";
import { installHostSkills, type HostSkills } from "../src/host-skills";
import { softMissRegressions } from "./soft-miss-regressions.test";
import type { ExtensionAPI, ExtensionContext, SkillRecord, MessageContent } from "../src/types";
import type { HostCapabilities } from "../src/host-adapter";

type Listener = (event: never, ctx: ExtensionContext) => unknown;
type Command = { handler(args: string, ctx: ExtensionContext): unknown };
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}
function textOf(value: unknown): string {
  const text = object(value).text;
  assert.equal(typeof text, "string");
  return text as string;
}

const root = await mkdtemp(join(tmpdir(), "broker-input-guard-"));
const previous = { ...process.env };
try {
  const rules = configuredRules({});
  for (const text of ["`$missing@unknownsource`", "```text\n$missing@unknownsource\n```", "~~~\n$missing@unknownsource\n~~~", "\\$missing@unknownsource", "prefix$missing@unknownsource", "``a `$missing@unknownsource` b``"]) {
    assert.deepEqual(parseInvocations(text, rules), [], `Literal example must not execute: ${text}`);
  }
  for (const ref of ["设计@notion", "namespace/design", "design@scope", "design@id@scope"]) {
    assert.equal(parseInvocations(`Use $${ref} please`, rules)[0]?.query, ref);
  }
  assert.equal(parseInvocations("\\\\$design@scope", rules).length, 0, "An attached escaped-backslash sequence is not a standalone invocation");
  assert.equal(parseInvocations("中文😀正文$design@scope，请执行", rules)[0]?.query, "design@scope", "A candidate accepted after Chinese prose must also activate on submission");
  const selected = { name: "设计", selectionToken: "设计@notion", token: "namespace/design" } as SkillRecord;
  assert.equal(matchDiscoveryRecord("设计@notion", [selected]).decision, "inject");
  assert.equal(matchDiscoveryRecord("namespace/design", [selected]).decision, "inject");

  const home = join(root, "home"), skills = join(root, "skills");
  await mkdir(join(skills, "guard-fixture"), { recursive: true });
  await mkdir(home);
  await writeFile(join(skills, "guard-fixture", "SKILL.md"), "---\nname: guard-fixture\ndescription: Input boundary fixture\n---\nLOCAL_READ_ONLY_FIXTURE_BODY\n");
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ sources: [{ id: "fixture", type: "filesystem", roots: [skills], requireAutoload: false }] }));
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.CONTEXT_BROKER_CONFIG = config;
  process.env.CONTEXT_BROKER_HOST = "omp";
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  delete process.env.CONTEXT_BROKER_ROOTS;
  delete process.env.NTN_SKILLS_DATA_HOME;
  const listeners = new Map<string, Listener[]>();
  const commands = new Map<string, Command>(), sends: MessageContent[] = [], notices: string[] = [], drafts: string[] = [];
  let aborts = 0;
  const ctx: ExtensionContext = { mode: "tui", hasUI: false, cwd: root, sessionManager: { getSessionId: () => "guard-session", getEntries: () => [] }, ui: { notify: text => notices.push(text), setEditorText: text => drafts.push(text) }, abort: () => { aborts++; } };
  // The recorder erases event variance internally; production registration remains typed.
  const api: ExtensionAPI = { pi: { buildSkillPromptMessage: async (_skill, input) => ({ message: "Native fixture body\n" + input.args }) }, on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler as unknown as Listener]); }, registerCommand(name, command) { commands.set(name, command); }, sendUserMessage: content => { sends.push(content); } };
  await contextBroker(api);
  assert.equal(commands.has("ntn-skills"), false, "CLI maintenance is invoked through ordinary bundled Skills, not a mirrored host command");
  const emit = async (name: string, event: unknown) => {
    const values = [];
    for (const listener of listeners.get(name) ?? []) values.push(await listener(event as never, ctx));
    return values;
  };
  const bootstrap = "Read-only bootstrap: explain $/manualpicker and $三Kind与@local/@notion说明; do not activate anything.";
  for (const source of [undefined, "extension"]) {
    const before = notices.length;
    assert.deepEqual(await emit("input", { text: bootstrap, source }), [undefined]);
    await emit("before_agent_start", { prompt: bootstrap, systemPrompt: "base" });
    assert.equal(notices.length, before, "Bootstrap must not report invocation failures");
  }
  assert.equal(aborts, 0);
  assert.deepEqual(sends, []);
  for (const [mode, source] of [["tui", "interactive"], ["rpc", "rpc"]] as const) {
    ctx.mode = mode;
    const text = "$missing@unknownsource $fixture/guard-fixture $fixture/guard-fixture user material";
    const image = { type: "image" as const, data: "guard-image", mimeType: "image/png" };
    const [input] = await emit("input", { text, source, images: [image] });
    assert.match(textOf(input), /^\/context-broker-submit /);
    await commands.get("context-broker-submit")!.handler(textOf(input).split(" ")[1]!, ctx);
    assert.deepEqual(sends.at(-1), [{ type: "text", text }, image]);
    const results = await emit("before_agent_start", { prompt: text, systemPrompt: "base" });
    const injected = results.filter(value => value && String(object(object(value).message ?? {}).content).includes("LOCAL_READ_ONLY_FIXTURE_BODY"));
    assert.equal(injected.length, 1);
    assert.equal(String(object(object(injected[0]).message).content).split("LOCAL_READ_ONLY_FIXTURE_BODY").length - 1, 1, "Repeated valid selection injects one body beside a miss");
    await emit("agent_start", {});
    await emit("agent_end", {});
  }
  assert.equal(sends.length, 2, "Each user submission dispatches exactly once");
  for (const unknown of [
    "$missing@unknownsource retain this draft",
    "$bunfs/root/chunks/cli-nxfh2cp0.js",
    "Amounts $10 and $1.25; variables $HOME ${USER}; paths $PWD/src and /tmp/$cache/file",
    "Code: `$missing@unknownsource`\n```sh\necho $HOME\n```",
  ]) {
    const before = sends.length, failures = notices.length, restored = drafts.length;
    const image = { type: "image" as const, data: "screenshot-bytes", mimeType: "image/png" };
    const [result] = await emit("input", { text: unknown, source: "rpc", images: [image] });
    if (result !== undefined) {
      await commands.get("context-broker-submit")!.handler(textOf(result).split(" ")[1]!, ctx);
      assert.equal(sends.length, before + 1, "A gated no-match submission dispatches exactly once");
      assert.deepEqual(sends.at(-1), [{ type: "text", text: unknown }, image]);
    } else assert.equal(sends.length, before, "Literal text continues through the host without another send");
    const results = await emit("before_agent_start", { prompt: unknown, systemPrompt: "base" });
    assert.ok(results.every(value => !JSON.stringify(value)?.includes("LOCAL_READ_ONLY_FIXTURE_BODY")), "No-match input must not load the unrelated Skill body");
    assert.equal(notices.length, failures, "Unknown refs and ordinary text do not report invocation failures");
    assert.equal(drafts.length, restored, "A miss does not restore a failed draft");
    await emit("agent_start", {});
    await emit("agent_end", {});
  }
  // Native slash commands are a public user entry even when the host consumes them before input.
  const nativeName = [...commands.keys()].find(name => name.startsWith("skill:"))!;
  assert.ok(nativeName);
  await commands.get(nativeName)!.handler("native material", ctx);
  const nativePrompt = sends.at(-1);
  assert.equal(nativePrompt, "Native fixture body\nnative material");
  await emit("before_agent_start", { prompt: nativePrompt });
  await emit("agent_start", {});
  await emit("agent_end", {});
  for (const mode of ["command", "transform"] as const) {
    const events = new Map<string, Listener>(), queued: string[] = [];
    const handlers = new Map<string, Command>();
    let reads = 0, version = 1, expansions = 0, host: HostSkills;
    const prompt = { kind: "prompt", id: "prompt", sourceId: "fixture", source: "filesystem", name: "task", token: "fixture/task", path: "/metadata/PROMPT.md", description: "Task", aliases: [], normalizedName: "task", normalizedAliases: [], normalizedDescription: "task", autoloadEnabled: false } as SkillRecord;
    const promptApi: ExtensionAPI = { on(name, handler) { events.set(name, handler as unknown as Listener); }, registerCommand(name, command) { handlers.set(name, command); }, sendUserMessage(content) { assert.equal(typeof content, "string"); queued.push(content as string); } };
    const one = (name: string, event: unknown) => events.get(name)!(event as never, ctx);
    const adapter: HostCapabilities = { paths: {}, submission: { mode, receipt: mode === "command" ? "handoff" : "input-digest" }, handledInput: { handled: true }, continuedInput: undefined, transformInput: text => ({ text }), registerCatalog: async () => true, installEditor: async () => {}, reload: async () => {}, updatedRead: input => ({ input }), buildPrompt: async () => { throw Error("Unexpected native expansion"); } };
    host = await installHostSkills(promptApi, {
      config: {}, getRecords: async () => ({ records: [prompt], failures: [] }),
      loadRecord: async record => {
        reads++;
        return { ...record, body: `s${version} contains $missing@unknownsource`, snapshotId: `s${version}`, path: `/snapshots/s${version}/PROMPT.md` };
      },
      needsPreflightPrompt: text => parseInvocations(text, rules).length > 0,
      preflightPrompt: async (text, context, signal) => { if (parseInvocations(text, rules).length) await host.activate(prompt, context, signal); },
      taskPrompt: async (text, context, signal) => {
        expansions++;
        return text + "\n" + (await host.activate(prompt, context, signal)).body;
      },
    }, adapter);
    for (const material of ["first", "second"]) {
      const input = await one("input", { text: "$fixture/task " + material, source: "rpc" });
      let submitted = textOf(input);
      if (mode === "command") { await handlers.get("context-broker-submit")!.handler(textOf(input).split(" ")[1]!, ctx); submitted = queued.at(-1)!; }
      await one("input", { text: submitted, source: "extension" });
      await one("before_agent_start", { prompt: submitted });
      await host.withPreparedPrompt(submitted, ctx, async (_signal, _native, original) => { assert.equal(original, "$fixture/task " + material); });
      await one("agent_start", {});
      version++;
      await one("before_agent_start", { prompt: "$missing@unknownsource bootstrap" });
      await one("input", { text: "ordinary queued input", source: "rpc" });
      const resource = await one("tool_call", { toolName: "read", input: { path: `/metadata/reference.md?snapshot=s${version - 1}` } });
      assert.equal(object(object(resource).input).path, `/snapshots/s${version - 1}/reference.md`, "Active turn keeps its Prompt snapshot until agent_end");
      await one("agent_end", {});
    }
    assert.equal(reads, 2, `${mode}: s1/s2 each prepare once`);
    assert.equal(expansions, 2, "Each Prompt submission expands exactly once");
  }
  for (const boundary of ["session_switch", "session_shutdown"] as const) {
    const pending = Promise.withResolvers<{ records: SkillRecord[]; failures: [] }>();
    const events = new Map<string, Listener[]>();
    const published: SkillRecord[][] = [];
    const deferredApi: ExtensionAPI = { on(name, handler) { events.set(name, [...(events.get(name) ?? []), handler as unknown as Listener]); }, registerCommand() {} };
    const deferredAdapter: HostCapabilities = {
      paths: {}, submission: { mode: "command", receipt: "handoff" }, metadataDiscovery: "deferred",
      handledInput: { handled: true }, continuedInput: undefined, transformInput: text => ({ text }),
      registerCatalog: async records => { published.push(records); return false; },
      installEditor: async () => {}, reload: async () => {}, updatedRead: input => ({ input }),
      buildPrompt: async () => { throw Error("Unexpected activation before metadata"); },
      systemPrompt: prompt => String(prompt) + "\nHost loaded-content guidance",
    };
    const metadata = { kind: "skill", id: "deferred", sourceId: "fixture", source: "filesystem", name: "deferred", token: "fixture/deferred", path: join(skills, "guard-fixture/SKILL.md"), metadataIndexPath: join(skills, "guard-fixture/SKILL.md"), description: "Deferred metadata", defaultDiscovery: true, aliases: [], normalizedName: "deferred", normalizedAliases: [], normalizedDescription: "deferred", autoloadEnabled: false } as SkillRecord;
    const host = await installHostSkills(deferredApi, {
      config: {}, getRecords: () => pending.promise,
      loadRecord: async () => { throw Error("Metadata must not load a body"); },
    }, deferredAdapter);
    assert.deepEqual(published, [], "Deferred factory returns before metadata publication");
    const dispatch = async (name: string, event: unknown) => {
      const values = [];
      for (const handler of events.get(name) ?? []) values.push(await handler(event as never, ctx));
      return values;
    };
    await dispatch("session_start", {});
    await dispatch(boundary, {});
    pending.resolve({ records: [metadata], failures: [] });
    if (boundary === "session_switch") {
      const results = await dispatch("before_agent_start", { prompt: "ordinary first turn", systemPrompt: "base" });
      assert.deepEqual(published, [[metadata]], "Session change must not discard initial metadata publication");
      const catalog = results.find(value => value && object(value).systemPrompt);
      assert.match(String(object(catalog).systemPrompt), /<name>fixture-deferred<\/name>/);
      assert.match(String(object(catalog).systemPrompt), /Host loaded-content guidance/);
      assert.doesNotMatch(String(object(catalog).systemPrompt), /LOCAL_READ_ONLY_FIXTURE_BODY/);
      await dispatch("session_shutdown", {});
    } else {
      // Draining the old discovery does not authorize publication after shutdown.
      await dispatch("before_agent_start", { prompt: "late lifecycle observation", systemPrompt: "base" });
      assert.deepEqual(published, [], "Shutdown must fence the pending metadata publication");
    }
  }
  await softMissRegressions(root);
  console.log("input guard behavior ok: public input receipts, literal/bootstrap and qualified pass-through, images, Prompt s1/s2");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  if (process.platform === "darwin") execFileSync("/usr/bin/trash", [root]);
}
