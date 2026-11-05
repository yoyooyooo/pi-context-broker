import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextBroker, { configuredRules, parseInvocations, matchDiscoveryRecord } from "../src/index";
import { installHostSkills, type HostSkills } from "../src/host-skills";
import { createOmpHostAdapter } from "../src/omp-host-adapter";
import { createPiHostAdapter } from "../src/pi-host-adapter";
import { SourceError } from "../src/notion-source";
import type { ActivePreparation } from "../src/skill-preparation";
import { softMissRegressions } from "./soft-miss-regressions.test";
import type { ExtensionAPI, ExtensionContext, SkillRecord, DiscoveryResult, MessageContent, NativeReadDefinition, NativeReadMetadata, NativeReadResult } from "../src/types";
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

async function pendingMetadataRegressions(root: string): Promise<void> {
  const path = join(root, "startup-fixed", "SKILL.md");
  await mkdir(join(root, "startup-fixed"));
  const body = "STARTUP_SELECTED_BODY_V1";
  await writeFile(path, body);
  const record: SkillRecord = {
    kind: "skill", id: "11111111-1111-4111-8111-111111111111", sourceId: "fixture", source: "notion", sourceScope: "startup-scope",
    ref: "skill://11111111-1111-4111-8111-111111111111/SKILL.md", entrypoint: "SKILL.md",
    name: "startup", token: "fixture/startup", path, description: "Startup fixture", aliases: [],
    normalizedName: "startup", normalizedAliases: [], normalizedDescription: "startup fixture", autoloadEnabled: false, defaultDiscovery: false,
  };
  const rules = configuredRules({});
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  async function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  function fixture(kind: "pi" | "omp" = "pi") {
    const events = new Map<string, Listener[]>(), tools = new Map<string, NativeReadDefinition>();
    const requests: Array<ReturnType<typeof Promise.withResolvers<DiscoveryResult<SkillRecord>>>> = [];
    const published: SkillRecord[][] = [], notices: string[] = [], loads: SkillRecord[] = [];
    let session = "startup-session", aborts = 0, entry: ActivePreparation | undefined, loaded = false, operation: AbortController | undefined;
    let load = async (selected: SkillRecord): Promise<SkillRecord> => ({ ...selected, body, snapshotId: "startup-v1" });
    const api: ExtensionAPI = {
      pi: {},
      on(name, handler) { events.set(name, [...events.get(name) ?? [], handler as unknown as Listener]); },
      registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
    };
    const ctx: ExtensionContext = {
      mode: "rpc", hasUI: false, cwd: root, sessionManager: { getSessionId: () => session, getEntries: () => [] },
      ui: { notify: text => notices.push(text) }, abort: () => { aborts++; operation?.abort(); },
    };
    const adapter = kind === "pi" ? createPiHostAdapter(api) : createOmpHostAdapter(api);
    if (kind === "omp") adapter.registerCatalog = async () => false;
    let host: HostSkills;
    const installed = installHostSkills(api, {
      config: { sources: [{ id: "fixture", type: "notion", prefetch: false }] }, getRecords: () => { const pending = Promise.withResolvers<DiscoveryResult<SkillRecord>>(); requests.push(pending); return pending.promise; },
      loadRecord: selected => { loads.push(selected); return load(selected); },
      onMetadata: records => published.push(records), onPreparation: value => { entry = value; },
      needsPreflightPrompt: text => parseInvocations(text, rules).length > 0,
      preflightPrompt: async (text, context, signal) => {
        if (parseInvocations(text, rules).some(request => request.query === "startup@fixture")) await host.prepare(record, context, signal);
      },
      buildPreparedPrompt: async (_text, _ctx, _signal, prepared) => ({ customType: "context-broker", content: prepared.map(record => record.body).join("\n"), display: false }),
      isLoaded: () => loaded,
      sessionSnapshot: () => loaded ? "startup-v1" : undefined,
      projectContext: messages => messages,
    }, adapter).then(value => { host = value; return value; });
    const emit = async (name: string, event: unknown = {}) => {
      const results = [];
      for (const handler of events.get(name) ?? []) results.push(await handler(event as never, ctx));
      return results;
    };
    const search = (signal?: AbortSignal) => tools.get(kind === "pi" ? "notion_list" : "skill_search")!.execute("startup-search", { query: "startup" }, signal, undefined, ctx);
    const begin = async (text: string) => {
      const [result] = await emit("input", { source: "rpc", text });
      const submitted = result && object(result).action === "transform" ? textOf(result) : text;
      await emit("before_agent_start", { prompt: submitted, systemPrompt: "base" });
      operation = new AbortController(); ctx.signal = operation.signal;
      await emit("agent_start");
      return { result, submitted, project: () => emit("context", { messages: [{ role: "user", content: submitted }] }) };
    };
    return {
      installed, emit, requests, published, notices, loads, search, adapter, ctx, begin,
      stop: () => operation?.abort(),
      async end() { await emit("agent_end"); ctx.signal = undefined; operation = undefined; },
      entry: () => entry, aborts: () => aborts, host: () => host,
      setLoad: (next: typeof load) => { load = next; }, setLoaded: () => { loaded = true; },
      move: () => { session = "replacement-session"; },
      resolve: (index = requests.length - 1, records = [record]) => requests[index]!.resolve({ records, failures: [] }),
      async close() { await emit("session_shutdown"); for (const pending of requests) pending.resolve({ records: [], failures: [] }); await installed; },
    };
  }
  {
    const f = fixture();
    try {
      await bounded(f.installed, "Pi registration must finish while metadata is unresolved");
      assert.equal(f.requests.length, 1);
      assert.deepEqual(await f.emit("resources_discover"), [{ skillPaths: [] }]);
      for (const text of ["ordinary first turn", "Code: `$startup@fixture`", "```text\n$startup@fixture\n```", "\\$startup@fixture", "Amounts 10 and variable `$HOME`"]) {
        assert.deepEqual(await bounded(f.emit("input", { source: "rpc", text }), `Ordinary Pi input must not await metadata: ${text}`), [{ action: "continue" }]);
        const [before] = await bounded(f.emit("before_agent_start", { prompt: text, systemPrompt: "base" }), "Ordinary Pi provider setup must not await metadata");
        assert.match(String(object(before).systemPrompt), /status="pending"/);
        assert.match(String(object(before).systemPrompt), /notion_list/);
      }
      assert.deepEqual(await bounded(f.emit("tool_call", { toolName: "read", input: { path: join(root, "ordinary.txt") } }), "An unrelated Pi read must not await Skill discovery"), [undefined]);
      assert.equal(f.requests.length, 1, "Ordinary input does not restart background directory maintenance");
      assert.deepEqual(f.loads, [], "No ordinary message or literal example reads a Skill body");
      f.resolve();
      await f.search();
      assert.equal(await f.adapter.registerCatalog([record]), false, "Late paths are not a refreshed Pi native catalog");
      assert.deepEqual(await f.emit("input", { source: "rpc", text: "$missing@unknownsource unchanged" }), [{ action: "continue" }], "An unresolved literal reference retains soft-miss pass-through after discovery");
      assert.deepEqual(f.loads, []);
    } finally { await f.close(); }
  }
  for (const text of ["$startup@fixture task", "/skill:fixture-startup task"]) {
    const f = fixture();
    try {
      await f.installed;
      const accepted = await bounded(f.begin(text), "Explicit input and before_agent_start must not wait for metadata");
      let finished = false;
      const context = accepted.project().then(value => { finished = true; return value; });
      await turn();
      assert.equal(finished, false, "Explicit acquisition waits inside the cancellable context boundary");
      assert.deepEqual(f.loads, []);
      assert.deepEqual(await f.emit("input", { source: "rpc", text }), [{ action: "handled" }], "A quick second Enter cannot acquire a second submission");
      f.resolve();
      const [projection] = await bounded(context, "Selected context must finish after metadata");
      assert.equal(f.loads.length, 1);
      assert.equal(f.loads[0]?.id, record.id);
      const submitted = accepted.submitted;
      if (text.startsWith("/skill:")) assert.equal(submitted, "\n" + text, "The original native input is neutralized without loading a body");
      assert.equal(JSON.stringify(projection).split(body).length - 1, 1, "The first provider context has the complete body once");
      await f.host().withPreparedPrompt(submitted, f.ctx, async (_signal, _native, original, prepared) => {
        assert.equal(original, text);
        assert.deepEqual(prepared?.map(value => [value.id, value.snapshotId]), [[record.id, "startup-v1"]]);
      });
      await f.end();
      f.setLoaded();
      const refreshing = f.host().refresh(f.ctx);
      assert.deepEqual(await bounded(f.emit("input", { source: "rpc", text: "continue with the active rules" }), "Active rules do not make ordinary input wait for a refresh"), [{ action: "continue" }]);
      await bounded(f.emit("before_agent_start", { prompt: "continue with the active rules", systemPrompt: "base" }), "Active ordinary provider setup stays nonblocking");
      const messages = [{ role: "user" as const, content: body }];
      assert.deepEqual(await f.emit("context", { messages }), [{ messages }], "Ordinary input preserves already active conversation bodies");
      assert.equal(f.loads.length, 1);
      f.resolve();
      await refreshing;
    } finally { await f.close(); }
  }
  for (const code of ["RATE_LIMITED", "NOTION_UNAVAILABLE", "ACCESS_DENIED"]) {
    const f = fixture();
    try {
      await f.installed;
      f.requests[0]!.reject(new SourceError(code, "fixture"));
      await assert.rejects(f.search(), new RegExp(code));
      assert.deepEqual(await bounded(f.emit("input", { source: "rpc", text: "ordinary after failure" }), "Failed discovery must not block ordinary input"), [{ action: "continue" }]);
      const [before] = await bounded(f.emit("before_agent_start", { prompt: "ordinary after failure", systemPrompt: "base" }), "Failed discovery must not block provider setup");
      assert.match(String(object(before).systemPrompt), /status="unavailable"/);
      for (const text of ["$startup@fixture task", "/skill:fixture-startup task"]) {
        const accepted = await bounded(f.begin(text), "Failed metadata cannot block input acceptance");
        await assert.rejects(accepted.project(), new RegExp(code));
        assert.equal(f.ctx.signal?.aborted, true, "An accurate acquisition failure must abort before provider dispatch");
        await f.end();
      }
      const [read] = await f.emit("tool_call", { toolName: "read", input: { path: record.ref } });
      assert.equal(object(read).block, true);
      assert.match(String(object(read).reason), new RegExp(code));
      assert.deepEqual(f.loads, []);
      assert.equal(f.aborts(), 2, "Both failed selected operations were stopped at context");
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      await f.installed;
      f.resolve();
      await f.search();
      const refreshing = f.host().refresh(f.ctx);
      const accepted = await f.begin("/skill:fixture-startup accepted identity");
      const context = accepted.project();
      await turn();
      assert.deepEqual(f.loads, []);
      f.resolve(1, [{ ...record, id: "22222222-2222-4222-8222-222222222222", ref: "skill://22222222-2222-4222-8222-222222222222/SKILL.md" }]);
      await refreshing;
      await context;
      assert.match(accepted.submitted, /accepted identity/);
      assert.deepEqual(f.loads.map(value => value.id), [record.id], "A late same-name record cannot replace the identity selected before discovery finished");
    } finally { await f.close(); }
  }
  for (const operation of ["search", "read"] as const) {
    const f = fixture();
    try {
      await f.installed;
      let finished = false;
      const pending = (operation === "search" ? f.search() : f.emit("tool_call", { toolName: "read", input: { path: record.ref } }))
        .then(value => { finished = true; return value; });
      await turn();
      assert.equal(finished, false, `${operation} waits for exact authorized metadata`);
      assert.deepEqual(f.loads, []);
      f.resolve();
      const result = await pending;
      if (operation === "search") assert.equal(object(object(result).details).count, 1);
      else assert.deepEqual(f.loads.map(value => value.id), [record.id]);
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      await f.installed;
      const controller = new AbortController();
      const pending = f.search(controller.signal);
      controller.abort();
      await assert.rejects(bounded(pending, "Cancelled search must not wait for metadata"), /cancelled/i);
      f.resolve();
      await f.search();
      assert.deepEqual(f.loads, [], "A cancelled metadata search cannot acquire a Skill body");
    } finally { await f.close(); }
  }
  for (const boundary of ["cancel", "session_start", "session_shutdown"] as const) {
    const f = fixture();
    try {
      await f.installed;
      const accepted = await f.begin("/skill:fixture-startup cancelled");
      const context = accepted.project();
      const settled = assert.rejects(context, /cancelled/i);
      await turn();
      if (boundary === "cancel") f.stop();
      else { f.move(); await f.emit(boundary); }
      await bounded(settled, "Cancellation must settle without waiting for metadata");
      f.resolve(0);
      await turn();
      if (boundary !== "cancel") assert.deepEqual(f.published, [], "An old session cannot publish late metadata");
      if (boundary === "session_start") {
        assert.deepEqual(await bounded(f.emit("input", { source: "rpc", text: "new session ordinary" }), "The new session cannot inherit the old wait"), [{ action: "continue" }]);
        f.resolve(1, [{ ...record, name: "replacement", token: "fixture/replacement" }]);
        await f.search();
        assert.equal(f.published.length, 1);
        assert.equal(f.published[0]?.[0]?.name, "replacement");
      }
      assert.deepEqual(f.loads, [], "A cancelled selection cannot load or dispatch after discovery finishes");
      assert.equal(f.aborts(), 0, "An old input cannot abort a new session or turn");
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      await f.installed;
      const controller = new AbortController();
      f.ctx.signal = controller.signal;
      const input = { path: record.ref };
      const pending = f.emit("tool_call", { toolName: "read", toolCallId: "stopped-native-read", input });
      await turn();
      controller.abort();
      const [result] = await bounded(pending, "Pi Stop must settle a selected native read while metadata is unresolved");
      assert.equal(object(result).block, true);
      assert.match(String(object(result).reason), /SOURCE_ACTIVATION_CANCELLED/);
      f.ctx.signal = undefined;
      f.resolve();
      await f.search();
      assert.equal(input.path, record.ref, "Late discovery cannot rewrite a stopped native read");
      assert.deepEqual(f.loads, [], "Late discovery cannot prepare or publish a stopped read's body");
      assert.deepEqual(await f.emit("input", { source: "rpc", text: "next ordinary turn" }), [{ action: "continue" }]);
      assert.equal(f.aborts(), 0);
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      await f.installed;
      f.requests[0]!.resolve({ records: [record], failures: [{ sourceId: "fixture", namespace: "fixture", type: "notion", code: "ACCESS_DENIED", message: "Denied fixture" }] });
      const search = await f.search();
      assert.deepEqual(object(search.details).failures, [{ source: "fixture", code: "ACCESS_DENIED" }]);
      assert.deepEqual(await f.emit("input", { source: "rpc", text: "ordinary with a failed source" }), [{ action: "continue" }]);
      const accepted = await f.begin("/skill:fixture-startup forbidden");
      await assert.rejects(accepted.project(), /ACCESS_DENIED/);
      assert.equal(f.ctx.signal?.aborted, true);
      assert.deepEqual(f.loads, [], "A known candidate cannot bypass current source permission failure");
    } finally { await f.close(); }
  }
  {
    const f = fixture("omp");
    try {
      await f.installed;
      let finished = false;
      const before = f.emit("before_agent_start", { prompt: "ordinary OMP", systemPrompt: "base" }).then(value => { finished = true; return value; });
      await turn();
      assert.equal(finished, false, "OMP retains its existing directory wait");
      f.resolve();
      await bounded(before, "OMP still completes after discovery");
    } finally { await f.close(); }
  }
}

async function coldOmpReadRegressions(root: string): Promise<void> {
  type MetadataSession = ConstructorParameters<NonNullable<NonNullable<ExtensionAPI["pi"]>["ReadTool"]>>[0];
  const schema = { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } } };
  const record: SkillRecord = {
    kind: "skill", id: "cold-native", sourceId: "fixture", source: "notion", sourceScope: "scope",
    name: "cold-native", token: "fixture/cold-native", path: join(root, "metadata-native/SKILL.md"),
    description: "Cold native read", aliases: [], normalizedName: "cold-native", normalizedAliases: [],
    normalizedDescription: "cold native read", autoloadEnabled: false, defaultDiscovery: false,
  };
  const snapshot: SkillRecord = { ...record, body: "COMPLETE_COLD_BODY", snapshotId: "s-cold", path: join(root, "fixed-native/SKILL.md") };
  const delay = () => new Promise<void>(resolve => setTimeout(resolve, 20));
  async function fixture({ wrap = true, active = true, source = "builtin" } = {}) {
    const settings = { style: "hashline" };
    let cwd = root;
    class Metadata implements NativeReadMetadata {
      readonly label = "Read";
      readonly parameters = schema;
      readonly strict = true;
      readonly readsSkillUris = true;
      readonly loadMode = "essential";
      readonly #session: MetadataSession;
      constructor(session: MetadataSession) { this.#session = session; }
      get description() { return `Native read ${object(this.#session.settings).style}`; }
      readonly approval = (args: unknown) => String(object(args).path).startsWith("exec://") ? "exec" : "read";
      readonly approvalCacheTargets = (args: unknown) => [this.#session.cwd + ":" + String(object(args).path)];
    }
    const events = new Map<string, Listener[]>(), commands = new Map<string, Command>();
    const activeNames = new Set(active ? ["read"] : []);
    let registered: NativeReadDefinition | undefined;
    const sends: MessageContent[] = [], notices: string[] = [];
    const calls: Array<{ input: Record<string, unknown>; signal?: AbortSignal }> = [];
    const nativeResult: NativeReadResult = { content: [{ type: "text", text: "native-formatted bytes" }, { type: "image", data: "image-bytes", mimeType: "image/png" }], details: { native: true }, hostField: "preserved" };
    const api: ExtensionAPI = {
      pi: { settings, ...(wrap ? { ReadTool: Metadata } : {}) },
      on(name, handler) { events.set(name, [...(events.get(name) ?? []), handler as unknown as Listener]); },
      registerCommand(name, command) { commands.set(name, command); },
      sendUserMessage(content) { sends.push(content); },
      getAllTools: () => [{ name: "read", description: registered?.description ?? "Native read", parameters: schema, sourceInfo: registered ? { source: "extension", path: registered.sourcePath } : { source, path: "<builtin:read>" } }],
      getActiveTools: () => [...activeNames],
      registerTool(tool) { if (tool.name === "read") registered = tool; if (!tool.defaultInactive) activeNames.add(tool.name); },
    };
    const ctx: ExtensionContext = {
      mode: "rpc", hasUI: false, cwd: root,
      sessionManager: { getCwd: () => cwd, getSessionId: () => "cold-native-session", getEntries: () => [] },
      ui: { notify: text => notices.push(text) },
      invokeTool: async (input, options) => { calls.push({ input, signal: options?.signal }); options?.onUpdate?.(nativeResult); return nativeResult; },
    };
    const adapter = createOmpHostAdapter(api);
    adapter.headlessActivationTimeoutMs = 5;
    adapter.registerCatalog = async () => true;
    let load: (signal?: AbortSignal) => Promise<SkillRecord> = async () => snapshot;
    let loads = 0;
    let host: HostSkills;
    host = await installHostSkills(api, {
      config: {}, getRecords: async () => ({ records: [record], failures: [] }),
      loadRecord: (_record, signal) => { loads++; return load(signal); },
      needsPreflightPrompt: text => text.startsWith("$fixture/"),
      preflightPrompt: async (_text, context, signal) => { await host.activate(record, context, signal); },
    }, adapter);
    const emit = async (name: string, event: unknown = {}) => {
      const result = [];
      for (const handler of events.get(name) ?? []) result.push(await handler(event as never, ctx));
      return result;
    };
    await emit("session_start");
    await host.refresh();
    return {
      ctx, emit, commands, sends, calls, notices, nativeResult, settings, host,
      activeNames, registered: () => registered, loads: () => loads,
      move: (next: string) => { cwd = next; }, setLoad: (next: typeof load) => { load = next; },
      read: () => { assert.ok(registered, "OMP must register the supported native read wrapper"); return registered; },
    };
  }
  {
    const f = await fixture();
    const read = f.read();
    assert.equal(read.approval({ path: "exec://native-target" }), "exec", "Wrapper must retain the native target-dependent tier");
    assert.equal(read.approval({ path: "ordinary.txt" }), "read");
    f.move(join(root, "moved"));
    assert.deepEqual(read.approvalCacheTargets({ path: "ordinary.txt" }), [join(root, "moved") + ":ordinary.txt"], "Remembered approvals use the current session cwd");
    f.settings.style = "plain";
    assert.equal(read.description, "Native read plain", "Native description follows live host settings");
    const params = { path: join(root, "ordinary-image.png"), offset: 2, limit: 3, i: "Reading image" };
    const updates: NativeReadResult[] = [];
    const result = await read.execute("ordinary-read", params, undefined, value => updates.push(value), f.ctx);
    assert.equal(f.loads(), 0, "An unrelated read must not load a source body");
    assert.equal(f.calls[0]?.input, params, "Unrelated native parameters remain untouched");
    assert.equal(result, f.nativeResult, "Native images, details and additional fields are preserved");
    assert.deepEqual(updates, [f.nativeResult]);
    await assert.rejects(read.execute("no-native", params, undefined, undefined, { ...f.ctx, invokeTool: undefined }), /HOST_NATIVE_READ_API_UNAVAILABLE/);
    assert.equal(f.calls.length, 1, "Missing delegation must not synthesize a native read result");
    await f.emit("session_shutdown");
  }
  {
    const f = await fixture();
    const started = Promise.withResolvers<void>(), pending = Promise.withResolvers<SkillRecord>();
    f.setLoad(async () => { started.resolve(); return pending.promise; });
    const input = { path: record.path, offset: 2, limit: 3 };
    assert.deepEqual(await f.emit("tool_call", { toolName: "read", input }), [undefined]);
    assert.equal(f.loads(), 0, "The bounded tool_call hook must not start cold preparation");
    const execution = f.read().execute("cold-read", input, undefined, undefined, f.ctx).then(value => ({ value }), error => ({ error }));
    await started.promise;
    await delay();
    assert.equal(f.calls.length, 0, "Native read waits for complete source preparation");
    pending.resolve(snapshot);
    const outcome = await execution;
    assert.ok("value" in outcome, "Tool execution may outlast the event-hook budget");
    assert.equal(outcome.value, f.nativeResult);
    assert.deepEqual(f.calls.map(call => call.input), [{ ...input, path: snapshot.path }]);
    assert.equal(input.path, record.path, "The original call is not rewritten while execution is pending");
    await f.emit("session_shutdown");
  }
  for (const boundary of ["abort", "session_before_switch"] as const) {
    const f = await fixture();
    const started = Promise.withResolvers<void>(), pending = Promise.withResolvers<SkillRecord>();
    let preparationSignal: AbortSignal | undefined;
    f.setLoad(async signal => { preparationSignal = signal; started.resolve(); return pending.promise; });
    const controller = new AbortController();
    const execution = f.read().execute("cancel-read", { path: record.path }, controller.signal, undefined, f.ctx).then(value => ({ value }), error => ({ error }));
    await started.promise;
    if (boundary === "abort") controller.abort();
    else await f.emit(boundary);
    assert.equal(preparationSignal?.aborted, true, `${boundary} reaches pending source work`);
    pending.resolve(snapshot);
    assert.ok("error" in await execution, "A late prepared snapshot cannot revive cancelled native execution");
    assert.equal(f.calls.length, 0);
    await f.emit("session_shutdown");
  }
  {
    const f = await fixture();
    f.setLoad(async () => { throw Object.assign(new Error("Denied"), { code: "ACCESS_DENIED" }); });
    await assert.rejects(f.read().execute("denied", { path: record.path }, undefined, undefined, f.ctx), /ACCESS_DENIED/);
    assert.equal(f.calls.length, 0, "Source failure must not read a metadata stub or delegate an unverified path");
    await f.emit("session_shutdown");
  }
  {
    const f = await fixture();
    const started = Promise.withResolvers<void>(), pending = Promise.withResolvers<SkillRecord>();
    f.setLoad(async () => { started.resolve(); return pending.promise; });
    const [transformed] = await f.emit("input", { source: "rpc", text: "$fixture/cold-native original material" });
    const command = f.commands.get("context-broker-submit");
    assert.ok(command);
    const preparing = command.handler(textOf(transformed).split(" ")[1] ?? "", f.ctx);
    await started.promise;
    await delay();
    assert.deepEqual(f.sends, [], "The command must not dispatch while the source is queued or reading");
    pending.resolve(snapshot);
    await preparing;
    assert.deepEqual(f.sends, ["$fixture/cold-native original material"], "A command outside the event hook dispatches once after long preparation");
    assert.deepEqual(f.notices, []);
    await f.emit("session_shutdown");
  }
  {
    const f = await fixture({ wrap: false });
    let preparationSignal: AbortSignal | undefined;
    f.setLoad(signal => { preparationSignal = signal; return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true })); });
    const [result] = await f.emit("tool_call", { toolName: "read", input: { path: record.path } });
    assert.equal(object(result).block, true);
    assert.match(String(object(result).reason), /SOURCE_ACTIVATION_TIMEOUT/, "The fallback event hook keeps its finite budget");
    assert.equal(preparationSignal?.aborted, true);
    await f.emit("session_shutdown");
  }
  for (const options of [{ active: false }, { source: "extension" }]) {
    const f = await fixture(options);
    if (options.active === false) {
      assert.equal(f.read().defaultInactive, true);
      assert.equal(f.activeNames.has("read"), false, "Wrapping must not enable a user-disabled native tool");
    } else assert.equal(f.registered(), undefined, "A third-party read must not be replaced");
    await f.emit("session_shutdown");
  }
}

const root = await mkdtemp(join(tmpdir(), "broker-input-guard-"));
const previous = { ...process.env };
try {
  await pendingMetadataRegressions(root);
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
  await coldOmpReadRegressions(root);
  await softMissRegressions(root);
  console.log("input guard behavior ok: public input receipts, literal/bootstrap and qualified pass-through, images, Prompt s1/s2");
} finally {
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  if (process.platform === "darwin") execFileSync("/usr/bin/trash", [root]);
}
