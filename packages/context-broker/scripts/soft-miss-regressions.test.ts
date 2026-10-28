import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import contextBroker, { buildDollarRegistry, invokeForContext } from "../src/index";
import { hostSkillName } from "../src/host-skills";
import { loadNotionSkill, ReferenceMiss, SourceError } from "../src/notion-source";
import { createNotionFixture, canary } from "../../../scripts/notion-integration-fixture.mjs";
import type { ExtensionAPI, ExtensionContext, MessageContent } from "../src/types";

type Listener = (event: never, ctx: ExtensionContext) => unknown;
type Command = { handler(args: string, ctx: ExtensionContext): unknown };
type Call = { source: string; command: string; args: string[] };
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

// Controlled CLI wire receipts exercise the real decoder and plugin callbacks.
// These are not live Notion, model, or installed-host success evidence.
export async function softMissRegressions(parentRoot: string): Promise<void> {
  const root = await mkdtemp(join(parentRoot, "soft-miss-"));
  const previous = { ...process.env };
  try {
    const faultPath = join(root, "fault.json"), callsPath = join(root, "calls.jsonl");
    await writeFile(faultPath, "{}");
    await writeFile(callsPath, "");
    const sources = [];
    for (const kind of ["skill", "prompt", "router"] as const) {
      const fixture = await createNotionFixture(join(root, kind));
      await fixture.setScenario("normal", { kind, defaultContext: false });
      const adapter = join(root, kind + "-wire.mjs");
      await writeFile(adapter, `
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { appendFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), source = ${JSON.stringify(kind)};
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ source, command: args[0], args }) + '\\n');
const fault = JSON.parse(readFileSync(${JSON.stringify(faultPath)}, 'utf8'))[source];
const page = /^skill:\\/\\/([^/?#]+)/.exec(args[1] ?? '')?.[1];
if (args[0] === 'list' && fault === 'discovery-denied') {
 console.log(JSON.stringify({ ok: false, error: { code: 'ACCESS_DENIED' } })); process.exit(1);
}
if (args[0] === 'read' && fault === 'delayed-miss') {
 const socket = connect(JSON.parse(readFileSync(${JSON.stringify(faultPath)}, 'utf8')).socket);
 socket.on('error', error => { throw error; });
 await Promise.withResolvers().promise;
}
if ((args[0] === 'read' && fault && fault !== 'incomplete' && fault !== 'export-miss' && fault !== 'removed') || (args[0] === 'export' && fault === 'export-miss')) {
 const code = fault === 'denied' ? 'ACCESS_DENIED' : 'NOT_FOUND';
 const path = fault === 'child-miss' ? 'v1/blocks/77777777-7777-4777-8777-777777777777/children' : fault === 'other-page' ? 'v1/pages/99999999-9999-4999-8999-999999999999' : 'v1/pages/' + (page ?? '11111111-1111-4111-8111-111111111111');
 const details = fault === 'generic-notfound' ? {} : { notion_code: 'object_not_found', path };
 console.log(JSON.stringify({ ok: false, error: { code, details } })); process.exit(1);
}
const command = ${JSON.stringify(fixture.command)};
const result = spawnSync(command[0], [...command.slice(1), ...args], { encoding: 'utf8' });
if (result.status !== 0) { process.stdout.write(result.stdout ?? ''); process.exit(result.status ?? 1); }
const receipt = JSON.parse(result.stdout);
if (args[0] === 'list' && fault === 'removed') { receipt.records = []; receipt.count = 0; }
if (args[0] === 'export' && fault === 'incomplete') unlinkSync(join(receipt.output, 'references/ledger.md'));
console.log(JSON.stringify(receipt));
`);
      sources.push({ id: kind, type: "notion" as const, command: [process.execPath, adapter], cacheDir: join(root, kind + "-cache") });
    }
    const config = { sources };
    const { records: discovered } = await buildDollarRegistry(config, root);
    const records = discovered.filter(record => record.source === "notion");
    assert.equal(records.length, 3);
    const skill = records.find(record => record.kind === "skill")!;
    const setFault = (value: Record<string, string>) => writeFile(faultPath, JSON.stringify(value));
    const calls = async (): Promise<Call[]> => (await readFile(callsPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

    // Only a read miss for the exact selected root page becomes ReferenceMiss.
    await setFault({ skill: "root-miss" });
    await assert.rejects(loadNotionSkill(skill, sources[0]!, root), error => error instanceof ReferenceMiss);
    for (const fault of ["generic-notfound", "other-page", "child-miss", "export-miss", "denied", "incomplete"]) {
      await setFault({ skill: fault });
      await assert.rejects(loadNotionSkill(skill, { ...sources[0]!, cacheDir: join(root, "strict-" + fault) }, root), error => {
        assert.ok(error instanceof SourceError, fault + " remains a true source failure");
        assert.ok(!(error instanceof ReferenceMiss));
        if (fault === "denied") assert.equal(error.code, "ACCESS_DENIED");
        if (fault === "incomplete") assert.equal(error.code, "SOURCE_EXPORT_INCOMPLETE");
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
      await setFault({ skill: "root-miss" });
      const configPath = join(root, host + "-config.json");
      await writeFile(configPath, JSON.stringify({ sources: sources.map(source => ({ ...source, cacheDir: join(root, host + "-" + source.id + "-cache") })) }));
      process.env.CONTEXT_BROKER_CONFIG = configPath;
      process.env.CONTEXT_BROKER_HOST = host;
      delete process.env.CONTEXT_BROKER_ROOTS;
      const listeners = new Map<string, Listener[]>(), commands = new Map<string, Command>();
      const sent: MessageContent[] = [], notices: string[] = [], drafts: string[] = [];
      let aborts = 0, nativeExpansions = 0;
      const ctx: ExtensionContext = { cwd: root, mode: "tui", hasUI: false, sessionManager: { getSessionId: () => host + "-soft-miss", getEntries: () => [] }, ui: { notify: text => notices.push(text), setEditorText: text => drafts.push(text) }, abort: () => { aborts++; } };
      const api: ExtensionAPI = {
        ...(host === "omp" ? { pi: { buildSkillPromptMessage: async () => { nativeExpansions++; throw Error("A missing native Skill must not expand"); } } } : {}),
        on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler as unknown as Listener]); },
        registerCommand(name, command) { commands.set(name, command); },
        sendUserMessage(content) { sent.push(content); },
      };
      await contextBroker(api);
      const emit = async (name: string, event: unknown) => {
        const values = [];
        for (const listener of listeners.get(name) ?? []) values.push(await listener(event as never, ctx));
        return values;
      };
      // Reuse the installed official Pi runner when this existing test setting is supplied.
      const hostRoot = process.env.PI_COMMAND_TEST_HOST_ROOT;
      const runnerModule = host === "pi" && hostRoot ? await import(pathToFileURL(join(hostRoot, "dist/core/extensions/runner.js")).href) : undefined;
      const runnerErrors: unknown[] = [];
      const runner = { extensions: [{ path: "soft-miss-plugin", handlers: listeners }], createContext: () => ctx, emitError: (error: unknown) => runnerErrors.push(error) };
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
          assert.equal((sent.at(-1) as unknown[])[1], image);
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
        await emit("agent_start", {});
        await emit("agent_end", {});
        return { submitted, results };
      };
      for (const round of ["FIRST", "SECOND"]) {
        const before = (await calls()).length;
        const text = `$unknown@elsewhere $ui-alpha@skill $ui-alpha@skill $ui-alpha@prompt $ui-alpha@prompt $ui-alpha@router ${round}`;
        const { submitted, results } = await submit(text);
        assert.ok(submitted.startsWith(text), "Original material and missing refs remain intact");
        assert.equal(submitted.split(canary).length - 1, 1, "One Prompt body per submission");
        assert.match(JSON.stringify(results), /kind=\\?"router/);
        assert.doesNotMatch(JSON.stringify(results), /kind=\\?"skill/);
        const turn = (await calls()).slice(before);
        assert.equal(turn.filter(call => call.source === "skill" && call.command === "read").length, 1, "A typed miss is memoized across every consumer in the same gate");
        assert.equal(turn.filter(call => call.source === "skill" && call.command === "export").length, 0);
        assert.equal(turn.filter(call => call.source === "prompt" && call.command === "read").length, 1);
        assert.equal(turn.filter(call => call.source === "router" && call.command === "read").length, 1);
      }
      for (const text of ["Amounts $10 and $1.25; variables $HOME ${USER}; paths $PWD/src and /tmp/$cache/file", "Code: `$missing@unknownsource`\n```sh\necho $HOME\n``` "]) {
        const before = (await calls()).length;
        const literal = await submit(text);
        assert.equal(literal.submitted, text);
        assert.deepEqual((await calls()).slice(before).filter(call => ["read", "export"].includes(call.command)), []);
      }
      for (const text of ["$missing@nowhere $also-missing", "$bunfs/root/chunks/cli-nxfh2cp0.js"]) {
        const before = (await calls()).length;
        const { submitted, results } = await submit(text);
        assert.equal(submitted, text);
        assert.doesNotMatch(JSON.stringify(results), /<context-broker-record\b/, "Unmatched targets must not activate a workflow");
        assert.deepEqual((await calls()).slice(before).filter(call => call.command === "read" || call.command === "export"), [], "No catalog match causes zero reads and exports");
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
      assert.ok(typedNative.submitted.startsWith(native), "Typed missing native selection retains its invocation and valid arguments");
      assert.match(typedNative.submitted, new RegExp(canary));
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
        assert.equal((await calls()).slice(before).filter(call => call.source === "skill" && ["read", "export"].includes(call.command)).length, 0, "Removed native command does not read a stale selection");
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
        assert.ok(result.submitted.startsWith(text), "An unmatched ref in an unavailable namespace remains user material");
        assert.equal(result.submitted.split(canary).length - 1, 1, "The valid Prompt still expands once beside an unavailable namespace");
        const turn = (await calls()).slice(before);
        assert.equal(turn.filter(call => call.source === "skill" && ["read", "export"].includes(call.command)).length, 0);
        assert.equal(turn.filter(call => call.source === "prompt" && call.command === "read").length, 1);
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
      for (const [fault, code] of [["denied", "ACCESS_DENIED"], ["incomplete", "SOURCE_EXPORT_INCOMPLETE"]]) {
        await setFault({ skill: fault! });
        await commands.get("context-broker")!.handler("refresh", ctx);
        notices.length = 0;
        const before = sent.length;
        const text = "$ui-alpha@skill keep this failed draft";
        const [input] = await emit("input", { text, images: [image], source: "rpc" });
        if (host === "omp") await commands.get("context-broker-submit")!.handler((object(input).text as string).split(" ")[1]!, ctx);
        else assert.equal(object(input).action, "handled");
        assert.equal(sent.length, before, "Known failure cannot dispatch a submission");
        assert.equal(drafts.at(-1), text);
        assert.ok(notices.some(notice => notice.includes(code!)), fault + " stays a visible failure");
      }
      const socket = join("/tmp", basename(root) + host + ".sock");
      const ready = Promise.withResolvers<void>();
      const server = createServer(() => { ready.resolve(); });
      server.listen(socket);
      await setFault({ skill: "delayed-miss", socket });
      await commands.get("context-broker")!.handler("refresh", ctx);
      const sendsBeforeCancel = sent.length;
      const input = emit("input", { text: "$ui-alpha@skill delayed material", images: [image], source: "rpc" });
      const pending = host === "omp" ? input.then(([result]) => commands.get("context-broker-submit")!.handler((object(result).text as string).split(" ")[1]!, ctx)) : input;
      await ready.promise;
      server.close();
      await emit("session_before_switch", {});
      await pending;
      assert.equal(sent.length, sendsBeforeCancel, "An old miss cannot dispatch after the session changes");
      await emit("session_shutdown", {});
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  }
}
