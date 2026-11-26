import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostSkillName } from "../src/host-skills";
import { currentNotionFixture } from "./fixtures/current-notion-source";
import { noConsumptionWrites } from "../src/consumption-effects";
const canary = "SOFT_MISS_CURRENT_BODY";
import type { ExtensionAPI, ExtensionContext, MessageContent } from "../src/types";

type Listener = (event: never, ctx: ExtensionContext) => unknown;
type Command = { handler(args: string, ctx: ExtensionContext): unknown };
type Call = { source: string; operation: string };
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

// Controlled SDK operations exercise the current decoder and plugin callbacks.
// These are not live Notion, model, or installed-host success evidence.
export async function softMissRegressions(parentRoot: string): Promise<void> {
  const root = await mkdtemp(join(parentRoot, "soft-miss-"));
  const previous = { ...process.env };
  try {
    const kinds = ["skill", "prompt", "router"] as const;
    const fixtures = await Promise.all(kinds.map((kind, index) => currentNotionFixture(kind,
      { identity: index + 1, name: "ui-alpha", body: "# " + kind + "\n" + canary + "\n" })));
    const primary = fixtures[0]!;
    const { default: contextBroker, buildDollarRegistry, invokeForContext } = await import(pathToFileURL(join(primary.root, "src/index.ts")).href);
    const { loadNotionSkill, ReferenceMiss, SourceError } = primary.boundary;
    const sources = fixtures.map((fixture, index) => ({ ...fixture.source, id: kinds[index]!, namespace: kinds[index]! }));
    let defaultLibrary = primary.descriptor.library_id;
    primary.state.selectLibrary = async options => options.library ?? defaultLibrary;
    primary.state.resolveLibrary = async options => {
      const fixture = fixtures.find(value => value.descriptor.library_id === (options.library ?? defaultLibrary));
      assert.ok(fixture, "Selected root must be one of the configured fixture Libraries");
      return fixture.descriptor;
    };
    let faults: Record<string, string> = {}, delayed = Promise.withResolvers<void>(), releasePrompt = Promise.withResolvers<void>();
    const adapters = fixtures.map((fixture, index) => {
      const kind = kinds[index]!, consume = fixture.state.consume.bind(fixture.state);
      return {
        library: fixture.source.library,
        list(options: { directory?: unknown; defaultView?: boolean; view?: string }) {
          if (faults[kind] === "discovery-denied") throw { code: "ACCESS_DENIED" };
          const catalog = faults[kind] === "removed" ? { ...fixture.state.catalog, records: [], count: 0 } : fixture.state.catalog;
          const directory = { ...catalog, records: [], count: 0, view: null, view_selection: "none" };
          return options.directory ? { version: 1, catalog: { ok: true, value: catalog }, directory: { ok: true, value: directory } }
            : options.defaultView || options.view ? directory : catalog;
        },
        async consume(input: Parameters<typeof consume>[0], options: Parameters<typeof consume>[1]) {
          const fault = faults[kind];
          if (fault === "delayed-prompt") { delayed.resolve(); await releasePrompt.promise; }
          if (fault === "delayed-miss") {
            assert.ok(options.signal, "Current SDK operation must receive its cancellation signal");
            delayed.resolve();
            await new Promise<never>((_resolve, reject) => {
              const cancel = () => reject({ code: "CANCELLED" });
              if (options.signal!.aborted) cancel();
              else options.signal!.addEventListener("abort", cancel, { once: true });
            });
          }
          fixture.state.transform = value => {
            if (fault === "entry-incomplete") {
              value.entries[0]!.source_body.has_more = true;
              return value;
            }
            if (!fault || fault === "removed" || fault === "discovery-denied" || fault === "delayed-prompt") return value;
            const code = fault === "denied" ? "ACCESS_DENIED" : "NOT_FOUND";
            const path = fault === "child-miss" ? "v1/blocks/77777777-7777-4777-8777-777777777777/children"
              : fault === "other-page" ? "v1/pages/99999999-9999-4999-8999-999999999999" : "v1/pages/" + fixture.record.locator.page_id;
            const details = fault === "generic-notfound" ? {} : { notion_code: "object_not_found", path,
              preparation: { status: "failed", required: [], nodes: [{ state: "failed", roles: [fault === "required-miss" ? "required" : "root"] }] } };
            return { version: 1, status: "failed", effects: noConsumptionWrites(), error: { code, message: "controlled selection failure", details } };
          };
          return consume(input, options);
        },
      };
    });
    const adapter = (library?: string) => {
      const found = adapters.find(value => value.library === library);
      assert.ok(found, "SDK must preserve the selected Library root");
      return found;
    };
    primary.state.list = options => adapter(options.library).list(options);
    primary.state.consume = (input, options) => adapter(options.library).consume(input, options);
    const config = { sources };
    const { records: discovered } = await buildDollarRegistry(config, root);
    const records = discovered.filter(record => record.source === "notion");
    assert.equal(records.length, 3);
    const skill = records.find(record => record.kind === "skill")!;
    const setFault = async (value: Record<string, string>) => { faults = value; };
    const calls = async (): Promise<Call[]> => primary.calls.map(call => ({
      source: kinds[fixtures.findIndex(fixture => fixture.source.library === call.options.library)]!, operation: call.operation,
    }));
    const malformedCode = process.env.CONTEXT_BROKER_GRAPH_CORE ? "CONSUME_INVALID_PROOF" : "SOURCE_PREPARATION_INVALID";

    // Only a read miss for the exact selected root page becomes ReferenceMiss.
    await setFault({ skill: "root-miss" });
    await assert.rejects(loadNotionSkill(skill, sources[0]!, root), error => error instanceof ReferenceMiss);
    for (const fault of ["generic-notfound", "other-page", "child-miss", "required-miss", "denied", "entry-incomplete"]) {
      await setFault({ skill: fault });
      await assert.rejects(loadNotionSkill(skill, { ...sources[0]!, cacheDir: join(root, "strict-" + fault) }, root), error => {
        assert.ok(error instanceof SourceError, fault + " remains a true source failure");
        assert.ok(!(error instanceof ReferenceMiss));
        if (fault === "denied") assert.equal(error.code, "ACCESS_DENIED");
        if (fault === "entry-incomplete") assert.equal(error.code, malformedCode);
        return true;
      });
    }
    await setFault({ router: "root-miss" });
    const router = records.find(record => record.kind === "router")!;
    const page = "11111111-1111-4111-8111-111111111111";
    const subscription = { ...router, id: "notion_subscription:" + page, ref: "skill://upstream%3A" + page + "/ROUTER.md", locator: { type: "notion_subscription" as const, subscription_id: page, database_id: "33333333-3333-4333-8333-333333333333", data_source_id: "44444444-4444-4444-8444-444444444444", target_database_id: "99999999-9999-4999-8999-999999999999" } };
    await assert.rejects(loadNotionSkill(subscription, sources[2]!, root), error => error instanceof SourceError && !(error instanceof ReferenceMiss), "A subscription lookup cannot turn a page-shaped error into a selected-page miss");
    await setFault({ skill: "root-miss" });
    const image = { type: "image" as const, data: "public-soft-miss-image", mimeType: "image/png" };
    const contextInput = [{ role: "user", content: [{ type: "text" as const, text: "$missing@elsewhere $ui-alpha@skill $ui-alpha@prompt $ui-alpha@router" }, image] }];
    const mixed = await invokeForContext({ messages: contextInput }, Promise.resolve([]), config, Promise.resolve(records));
    assert.equal(mixed!.messages![0]!.role, "user");
    assert.match(JSON.stringify(mixed!.messages![0]), new RegExp(canary));
    assert.match(JSON.stringify(mixed!.messages!.at(-1)), /kind=\\?"router/);
    assert.doesNotMatch(JSON.stringify(mixed), /kind=\\?"skill/);
    assert.equal((mixed!.messages![0]!.content as unknown[])[1], image);
    assert.match(JSON.stringify(mixed), /context-broker-unavailable/);

    for (const host of ["omp", "pi"] as const) {
      defaultLibrary = primary.descriptor.library_id;
      await setFault({ skill: "root-miss" });
      const configPath = join(root, host + "-config.json");
      await writeFile(configPath, JSON.stringify({ sources: sources.map(source => ({ ...source, cacheDir: join(root, host + "-" + source.id + "-cache") })) }));
      process.env.CONTEXT_BROKER_CONFIG = configPath;
      process.env.CONTEXT_BROKER_HOST = host;
      delete process.env.CONTEXT_BROKER_ROOTS;
      const listeners = new Map<string, Listener[]>(), commands = new Map<string, Command>();
      const sent: MessageContent[] = [], notices: string[] = [], drafts: string[] = [];
      let aborts = 0, nativeExpansions = 0, operation: AbortController | undefined;
      const ctx: ExtensionContext = { cwd: root, mode: "tui", hasUI: false, sessionManager: { getSessionId: () => host + "-soft-miss", getEntries: () => [] }, ui: { notify: text => notices.push(text), setEditorText: text => drafts.push(text) }, abort: () => { aborts++; operation?.abort(); } };
      const api: ExtensionAPI = {
        ...(host === "omp" ? { pi: { buildSkillPromptMessage: async () => { nativeExpansions++; throw Error("A missing native Skill must not expand"); } } } : {}),
        on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler as unknown as Listener]); },
        registerCommand(name, command) { commands.set(name, command); },
        sendUserMessage(content) { sent.push(content); },
      };
      const registrationStart = (await calls()).length;
      await contextBroker(api);
      const emit = async (name: string, event: unknown) => {
        const values = [];
        let current = event;
        for (const listener of listeners.get(name) ?? []) {
          const result = await listener(current as never, ctx);
          values.push(result);
          if (name === "context" && result && typeof result === "object" && "messages" in result && Array.isArray(result.messages))
            current = { ...object(current), messages: result.messages };
        }
        return values;
      };
      // Reuse the installed official Pi runner when this existing test setting is supplied.
      const hostRoot = process.env.PI_COMMAND_TEST_HOST_ROOT;
      const runnerModule = host === "pi" && hostRoot ? await import(pathToFileURL(join(hostRoot, "dist/core/extensions/runner.js")).href) : undefined;
      const runnerErrors: unknown[] = [];
      const runner = { extensions: [{ path: "soft-miss-plugin", handlers: listeners }], createContext: () => ctx, emitError: (error: unknown) => runnerErrors.push(error) };
      const projectPi = async (submitted: string) => {
        operation = new AbortController(); ctx.signal = operation.signal;
        await emit("agent_start", {});
        try {
          const results = await emit("context", { messages: [{ role: "user", content: [{ type: "text", text: submitted }, image] }] });
          await emit("before_provider_request", { type: "before_provider_request", payload: {} });
          await emit("after_provider_response", { type: "after_provider_response", status: 200, headers: {} });
          return results;
        } finally { await emit("agent_end", {}); ctx.signal = undefined; operation = undefined; }
      };
      const submit = async (text: string) => {
        const before = sent.length;
        const input = runnerModule
          ? await runnerModule.ExtensionRunner.prototype.emitInput.call(runner, text, [image], "interactive")
          : (await emit("input", { text, images: [image], source: "interactive" }))[0];
        let submitted = text;
        if (host === "omp" && input !== undefined) {
          const command = object(input).text;
          assert.equal(typeof command, "string");
          await commands.get("context-broker-submit")!.handler((command as string).split(" ")[1]!, ctx);
          assert.equal(sent.length, before + 1, "OMP dispatches each input once");
          assert.deepEqual((sent.at(-1) as unknown[])[1], image, "The admitted image retains its exact content after receipt copying");
          const content = sent.at(-1)!;
          submitted = typeof content === "string" ? content : content.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
        } else {
          assert.equal(sent.length, before, "An unchanged input or Pi transform never resends");
          if (input && object(input).action === "transform") {
            submitted = object(input).text as string;
            assert.deepEqual(object(input).images, [image]);
          } else if (host === "pi") assert.equal(object(input).action, "continue");
        }
        const results = await emit("before_agent_start", { prompt: submitted, systemPrompt: "base" });
        let task = submitted;
        if (host === "pi") {
          const contexts = await projectPi(submitted);
          const messages = object(contexts.at(-1)).messages as Array<{ role: string; content: MessageContent; customType?: string }>;
          const user = messages.find(message => message.role === "user")!;
          assert.ok(Array.isArray(user.content)); assert.deepEqual(user.content[1], image);
          submitted = String(object(user.content[0]).text);
          task = messages.filter(message => message.customType === "context-broker-task").map(message => message.content).join("\n");
          results.push(...contexts);
        } else { await emit("agent_start", {}); await emit("agent_end", {}); }
        return { submitted, results, task };
      };
      const ordinary = await submit("$ui-alpha use the default Library only");
      assert.equal(ordinary.task.split(canary).length - 1, 0, "An unqualified same-name selection cannot borrow another Library's Prompt");
      assert.doesNotMatch(JSON.stringify(ordinary.results), /kind=\\?"router/);
      assert.ok((await calls()).slice(registrationStart).filter(call => ["list", "consume"].includes(call.operation))
        .every(call => call.source === "skill"), "Default discovery and names do not enumerate another configured Library");
      delayed = Promise.withResolvers<void>(); releasePrompt = Promise.withResolvers<void>();
      await setFault({ prompt: "delayed-prompt" });
      const late = submit("$ui-alpha@prompt delayed explicit Source");
      await delayed.promise;
      defaultLibrary = fixtures[2]!.descriptor.library_id;
      releasePrompt.resolve();
      const lateResult = await late;
      assert.equal(lateResult.task.split(canary).length - 1, 1);
      assert.match(lateResult.task, new RegExp(fixtures[1]!.descriptor.library_id), "A late explicit Source result retains its own root after the global default changes");
      const changedAt = (await calls()).length;
      const switched = await submit("$ui-alpha use the newly selected default Library");
      assert.match(JSON.stringify(switched.results), /kind=\\?"router/);
      assert.ok((await calls()).slice(changedAt).filter(call => ["list", "consume"].includes(call.operation))
        .every(call => call.source === "router"), "The next input selects the new default without inheriting the prior explicit Source");
      defaultLibrary = primary.descriptor.library_id;
      await setFault({ skill: "root-miss" });
      for (const round of ["FIRST", "SECOND"]) {
        const before = (await calls()).length;
        const text = `$unknown@elsewhere $ui-alpha@skill $ui-alpha@skill $ui-alpha@prompt $ui-alpha@prompt $ui-alpha@router ${round}`;
        const { submitted, results, task } = await submit(text);
        assert.ok(submitted.startsWith(text), "Original material and missing refs remain intact");
        assert.equal(task.split(canary).length - 1, 1, "One Prompt body per submission in the actual task projection: " + JSON.stringify({ host, notices, calls: (await calls()).slice(before), submitted }));
        if (host === "pi") assert.match(task, new RegExp(fixtures[1]!.descriptor.library_id), "An explicit Source keeps its own full Library identity");
        assert.match(JSON.stringify(results), /kind=\\?"router/);
        assert.doesNotMatch(JSON.stringify(results), /kind=\\?"skill/);
        const turn = (await calls()).slice(before);
        assert.equal(turn.filter(call => call.source === "skill" && call.operation === "consume").length, 1, "A typed miss is memoized across every consumer in the same gate");
        assert.equal(turn.filter(call => call.source === "prompt" && call.operation === "consume").length, 1);
        assert.equal(turn.filter(call => call.source === "router" && call.operation === "consume").length, 1);
      }
      for (const text of ["Amounts $10 and $1.25; variables $HOME ${USER}; paths $PWD/src and /tmp/$cache/file", "Code: `$missing@unknownsource`\n```sh\necho $HOME\n``` "]) {
        const before = (await calls()).length;
        const literal = await submit(text);
        assert.equal(literal.submitted, text);
        assert.deepEqual((await calls()).slice(before).filter(call => ["consume", "read"].includes(call.operation)), []);
      }
      for (const text of ["$missing@nowhere $also-missing", "$bunfs/root/chunks/cli-nxfh2cp0.js"]) {
        const before = (await calls()).length;
        const { submitted, results } = await submit(text);
        assert.equal(submitted, text);
        assert.doesNotMatch(JSON.stringify(results), /<context-broker-record\b/, "Unmatched targets must not activate a workflow");
        assert.deepEqual((await calls()).slice(before).filter(call => ["consume", "read"].includes(call.operation)), [], "No catalog match causes zero body or resource operations");
      }
      const selectedMissingText = "$ui-alpha@skill $missing@nowhere";
      const selectedMissing = await submit(selectedMissingText);
      assert.equal(selectedMissing.submitted, selectedMissingText, "An all-missing selected submission keeps text and images");
      assert.match(JSON.stringify(selectedMissing.results), /context-broker-unavailable/, "Matched missing references are explicitly not loaded for the model");
      assert.ok(notices.some(notice => notice.includes("not loaded")), "The user sees that the selected content did not load");
      assert.doesNotMatch(JSON.stringify(selectedMissing.results), /<context-broker-record\b/, "Missing selected pages must not activate a workflow");
      const nativeName = "skill:" + hostSkillName(skill);
      const native = "/" + nativeName + " $ui-alpha@prompt $ui-alpha@router native material";
      const typedNative = await submit(native);
      if (host === "pi") assert.equal(typedNative.submitted, "\n" + native, "Pi retains exactly the protected invocation and valid arguments");
      else assert.ok(typedNative.submitted.startsWith(native), "Typed missing native selection retains its invocation and valid arguments");
      assert.match(typedNative.task, new RegExp(canary));
      assert.match(JSON.stringify(typedNative.results), /kind=\\?"router/);
      if (host === "omp") {
        assert.ok(commands.has(nativeName));
        await setFault({ skill: "removed" });
        await commands.get("context-broker")!.handler("refresh", ctx);
        notices.length = 0;
        const before = (await calls()).length, sends = sent.length;
        await commands.get(nativeName)!.handler("$ui-alpha@prompt stale command material", ctx);
        assert.equal(sent.length, sends + 1, "Previously registered native command still dispatches after removal");
        const content = sent.at(-1)!;
        const submitted = typeof content === "string" ? content : content.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
        assert.ok(submitted.startsWith("/" + nativeName));
        assert.match(submitted, /stale command material/);
        assert.match(submitted, new RegExp(canary));
        assert.equal((await calls()).slice(before).filter(call => call.source === "skill" && ["consume", "read"].includes(call.operation)).length, 0, "Removed native command does not read a stale selection");
        await emit("before_agent_start", { prompt: submitted, systemPrompt: "base" });
        await emit("agent_start", {});
        await emit("agent_end", {});
      }
      await setFault({ skill: "discovery-denied" });
      await commands.get("context-broker")!.handler("refresh", ctx);
      assert.ok(notices.some(notice => notice.includes("ACCESS_DENIED")), "Discovery still reports the unavailable source");
      notices.length = 0;
      for (const text of ["$missing@skill $skill/missing $ui-alpha@prompt unavailable namespace material", "/skill:skill-missing $ui-alpha@prompt unavailable native namespace material"]) {
        const before = (await calls()).length;
        const result = await submit(text);
        if (host === "pi") assert.equal(result.submitted, text.startsWith("/skill:") ? "\n" + text : text, "Pi preserves unmatched user material with only the native invocation protection newline");
        else assert.ok(result.submitted.startsWith(text), "An unmatched ref in an unavailable namespace remains user material");
        assert.equal(result.task.split(canary).length - 1, 1, "The valid Prompt still expands once beside an unavailable namespace");
        const turn = (await calls()).slice(before);
        assert.equal(turn.filter(call => call.source === "skill" && ["consume", "read"].includes(call.operation)).length, 0);
        assert.equal(turn.filter(call => call.source === "prompt" && call.operation === "consume").length, 1);
        assert.deepEqual(notices, [], "An unknown ref does not repeat discovery failures as activation failures");
      }
      await setFault({ skill: "root-miss" });
      await commands.get("context-broker")!.handler("refresh", ctx);
      notices.length = 0;
      assert.equal(nativeExpansions, 0);
      assert.equal(aborts, 0);
      assert.deepEqual(drafts, []);
      assert.deepEqual(notices, [], "Soft misses do not emit failure notices");
      assert.deepEqual(runnerErrors, []);
      for (const [fault, code] of [["denied", "ACCESS_DENIED"], ["entry-incomplete", malformedCode]]) {
        await setFault({ skill: fault! });
        await commands.get("context-broker")!.handler("refresh", ctx);
        notices.length = 0;
        const before = sent.length;
        const text = "$ui-alpha@skill keep this failed draft";
        const [input] = await emit("input", { text, images: [image], source: "rpc" });
        if (host === "omp") await commands.get("context-broker-submit")!.handler((object(input).text as string).split(" ")[1]!, ctx);
        else {
          assert.equal(object(input).action, "continue");
          await emit("before_agent_start", { prompt: text, systemPrompt: "base" });
          const projected = await projectPi(text);
          assert.match(JSON.stringify(projected), new RegExp(code!));
          assert.match(JSON.stringify(projected), /context-broker-preparation-warning/);
          assert.ok(notices.some(notice => notice.includes(code!)));
          assert.equal(aborts, 0, "A failed Skill preparation cannot abort Pi's user turn");
        }
        assert.equal(sent.length, before, "A failed selection must not dispatch a duplicate submission");
        if (host === "omp") {
          assert.equal(drafts.at(-1), text);
          assert.ok(notices.some(notice => notice.includes(code!)), fault + " stays a visible failure");
        }
      }
      delayed = Promise.withResolvers<void>();
      await setFault({ skill: "delayed-miss" });
      await commands.get("context-broker")!.handler("refresh", ctx);
      const sendsBeforeCancel = sent.length;
      const input = emit("input", { text: "$ui-alpha@skill delayed material", images: [image], source: "rpc" });
      const pending = host === "omp" ? input.then(([result]) => commands.get("context-broker-submit")!.handler((object(result).text as string).split(" ")[1]!, ctx)) : input.then(async () => {
        await emit("before_agent_start", { prompt: "$ui-alpha@skill delayed material", systemPrompt: "base" });
        await projectPi("$ui-alpha@skill delayed material");
      });
      const settled = pending;
      await delayed.promise;
      await emit("session_before_switch", {});
      await settled;
      assert.equal(sent.length, sendsBeforeCancel, "An old miss cannot dispatch after the session changes");
      await emit("session_shutdown", {});
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    const ownedRoot = await realpath(root);
    if (process.platform === "darwin") execFileSync("/usr/bin/trash", [ownedRoot]);
    else console.log(`soft-miss owned scratch retained on ${process.platform}: ${ownedRoot}`);
  }
}
