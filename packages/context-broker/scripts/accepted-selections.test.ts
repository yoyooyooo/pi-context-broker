import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAcceptedSelections } from "../src/accepted-selections";
import { createInputReceipt, type InputReceipt } from "../src/skill-preparation";
import { completionMenu } from "./fixtures/completion-menu";
import { createDollarSkillAutocompleteProvider } from "../src/dollar";
import { recordIdentity, recordToken, preciseRecordToken } from "../src/discovery-records";
import { completeDollarRequest } from "../src/completion";
import { installHostSkills } from "../src/host-skills";
import { createLibrarySelection, libraryContext, LIBRARY_SELECTION_ENTRY } from "../src/library-selection";
import { hasLoadedSkill, invokeBeforeAgentStart, invokeForContext, matchDiscoveryRecord } from "../src/index";
import { skillRecordFromFile } from "../src/skill-records";
import type { AutocompleteProvider, ExtensionContext, ExtensionAPI, DiscoveryRecord, SessionEntry, AgentMessage, ImageContent, ConfigFile } from "../src/types";
import type { HostCapabilities } from "../src/host-adapter";

async function deferredInputReceipts(firstRecord: DiscoveryRecord, secondRecord: DiscoveryRecord, cwd: string): Promise<void> {
  const uuid = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  const a = uuid(1), b = uuid(2), first = { ...firstRecord, selectionToken: "same-choice" }, second = { ...secondRecord, selectionToken: "same-choice" };
  async function fixture() {
    type Listener = (event: never, context: ExtensionContext) => unknown;
    const hooks = new Map<string, Listener[]>(), choices = createAcceptedSelections<DiscoveryRecord>(recordToken);
    const receipts: InputReceipt[] = [], prepared: string[] = [], notices: string[] = [];
    const seen: Array<{ stage: string; id: string; library?: string; identity: string; images?: ImageContent[]; text?: string }> = [];
    let branch: SessionEntry[] = [], session = "receipt-session", order = 0;
    const operation = new AbortController();
    const config: ConfigFile = { sources: [{ id: "a", type: "notion", library: a }, { id: "b", type: "notion", library: b }] };
    const owner = createLibrarySelection(config, async input => {
      const table = (n: number) => ({ database_id: uuid(n), data_source_id: uuid(n + 1), property_ids: {} });
      return { version: 2, library_id: input.library!, operation_id: "fixture", skills: table(10), files: table(20), records: table(30), sources: table(40) };
    }, async input => input.library ?? a);
    const ctx: ExtensionContext = { cwd, mode: "tui", signal: operation.signal,
      sessionManager: { getSessionId: () => session, getBranch: () => branch, getEntries: () => branch,
        buildSessionProjection: () => ({ entries: branch.map(sourceEntry => ({ sourceEntry, messages: sourceEntry.message ? [sourceEntry.message] : [] })),
          messages: branch.flatMap(entry => entry.message ? [entry.message] : []) }) },
      ui: { notify: message => notices.push(message) } };
    const api: ExtensionAPI = { on(name, handler) { hooks.set(name, [...hooks.get(name) ?? [], handler as unknown as Listener]); }, registerCommand() {} };
    const adapter: HostCapabilities = { paths: { host: "pi" }, metadataDiscovery: "deferred", submission: { mode: "transform", receipt: "handoff" },
      handledInput: { action: "handled" }, continuedInput: { action: "continue" }, transformInput: (text, images) => ({ action: "transform", text, images }),
      registerCatalog: async () => false, installEditor: async () => {}, reload: async () => {}, updatedRead: input => ({ input }),
      buildPrompt: async () => { throw new Error("No native expansion in input-identity replay"); } };
    const consume = (stage: string, context: ExtensionContext, receipt?: InputReceipt) => {
      assert.ok(receipt, "Every explicit input must retain its receipt");
      const selected = choices.forSubmission(receipt).get("same-choice");
      assert.ok(selected, "Deferred/composed cancellation signals cannot lose the accepted identity");
      seen.push({ stage, id: receipt.id, library: libraryContext(context)?.local()?.root, identity: recordIdentity(selected),
        text: receipt.event.text, images: structuredClone(receipt.event.images) });
      return selected;
    };
    await installHostSkills(api, { config, librarySelection: owner,
      getRecords: async () => ({ records: [], failures: [] }), loadRecord: async () => { throw new Error("No content read in identity replay"); },
      needsPreflightPrompt: text => text.includes("$same-choice"),
      onInputReceipt: receipt => { receipts.push(receipt); choices.capture(receipt, ["same-choice"]); },
      onPreparation: entry => prepared.push(entry.id),
      preflightPrompt: async (_text, context, signal, receipt) => {
        assert.notEqual(signal, operation.signal, "Replay the actual Pi composed cancellation signal");
        consume("preflight", context, receipt);
      },
      taskPrompt: async (text, context, _signal, invocation) => { consume("task", context, invocation?.receipt); return text; },
      buildPreparedPrompt: async (_text, context, _signal, _prepared, receipt) => {
        const selected = consume("build", context, receipt);
        return { customType: "input-receipt-proof", content: recordIdentity(selected), display: false };
      },
    }, adapter);
    const emit = async (name: string, event: unknown = {}) => {
      const values: unknown[] = [];
      for (const listener of hooks.get(name) ?? []) values.push(await listener(event as never, ctx));
      return values;
    };
    const addUser = async (text: string, images?: ImageContent[], normalized?: { text: string; images: ImageContent[] }) => {
      const message: AgentMessage = { role: "user", content: images?.length ? [{ type: "text", text }, ...structuredClone(images)] : text };
      // Pi normalizes queued images in place before message_start, then persists
      // that same message object at message_end. Context handlers receive copies.
      if (normalized) message.content = [{ type: "text", text: normalized.text }, ...structuredClone(normalized.images)];
      await emit("message_start", { type: "message_start", message });
      branch.push({ type: "message", id: "user-" + ++order, message });
      return message;
    };
    const context = () => emit("context", { messages: structuredClone(branch.flatMap(entry => entry.message ? [entry.message] : [])) });
    const select = (root: string) => {
      branch.push({ type: "custom", id: "library-" + ++order, customType: LIBRARY_SELECTION_ENTRY, data: { version: 1, library: root, status: "ready" } });
      owner.invalidate();
    };
    const start = async () => {
      await emit("agent_start"); await addUser("running"); await context();
    };
    return { ctx, choices, receipts, prepared, seen, notices, operation, emit, addUser, context, select, start,
      replaceSession() { session = "replacement"; branch = []; owner.invalidate(); },
      close: () => emit("session_shutdown") };
  }
  {
    const h = await fixture();
    try {
      h.select(a); h.choices.remember(h.ctx, first);
      const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "ORIGINAL" }];
      const input = h.emit("input", { text: "$same-choice direct", images, source: "interactive" });
      assert.equal(h.receipts.length, 1, "Receipt creation and draft capture precede the input hook's first await");
      images[0]!.data = "LATER_DRAFT";
      h.choices.remember(h.ctx, second);
      await input;
      await h.emit("before_agent_start", { prompt: "$same-choice direct", systemPrompt: "" });
      await h.emit("agent_start");
      await h.addUser("$same-choice direct", h.receipts[0]!.event.images);
      await h.context();
      assert.deepEqual(h.seen.map(value => [value.stage, value.library, value.identity, value.images?.[0]?.data]),
        ["preflight", "task", "build"].map(stage => [stage, a, recordIdentity(first), "ORIGINAL"]));
      assert.equal(new Set(h.seen.map(value => value.id)).size, 1);
      assert.equal(recordIdentity(h.choices.forContext(h.ctx).get("same-choice")!), recordIdentity(second));
      assert.deepEqual(h.notices, []);
    } finally { await h.close(); }
  }
  {
    const h = await fixture();
    try {
      await h.start(); h.select(a); h.choices.remember(h.ctx, first);
      const firstImage: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "A_IMAGE" }];
      const secondImage: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "B_IMAGE" }];
      await h.emit("input", { text: "$same-choice same text", images: firstImage, source: "rpc", streamingBehavior: "followUp" });
      h.select(b); h.choices.remember(h.ctx, second);
      await h.emit("input", { text: "$same-choice same text", images: secondImage, source: "rpc", streamingBehavior: "followUp" });
      h.choices.remember(h.ctx, { ...second, path: "/next-draft/SKILL.md" });
      firstImage[0]!.data = "MUTATED";
      const users: AgentMessage[] = [];
      for (const receipt of h.receipts) users.push(await h.addUser(receipt.event.text!, receipt.event.images));
      const [result] = await h.context();
      assert.equal(h.prepared.length, 2, "Each queued input prepares independently");
      assert.deepEqual(h.seen.filter(value => value.stage === "preflight").map(value => [value.library, value.identity, value.images?.[0]?.data]),
        [[a, recordIdentity(first), "A_IMAGE"], [b, recordIdentity(second), "B_IMAGE"]]);
      assert.equal(new Set(h.seen.map(value => value.id)).size, 2, "Same text and token still have distinct receipt identities");
      assert.ok(result && typeof result === "object" && "messages" in result && Array.isArray(result.messages));
      for (const user of users) assert.ok(result.messages.some(message => JSON.stringify(message) === JSON.stringify(user)), "Original native user text and images remain attached");
      assert.deepEqual(h.notices, []);
    } finally { await h.close(); }
  }
  {
    const h = await fixture();
    try {
      const text = "$same-choice initial and queued";
      h.select(a); h.choices.remember(h.ctx, first);
      await h.emit("input", { text, source: "interactive" });
      await h.emit("before_agent_start", { prompt: text, systemPrompt: "" });
      h.select(b); h.choices.remember(h.ctx, second);
      await h.emit("input", { text, source: "rpc", streamingBehavior: "steer" });
      await h.emit("agent_start");
      await h.addUser(text); await h.context();
      assert.deepEqual(h.seen.filter(value => value.stage === "preflight").map(value => [value.library, value.identity]), [[a, recordIdentity(first)]],
        "An identical queued input cannot take the initial prompt's message_start occurrence");
      await h.addUser(text); await h.context();
      assert.deepEqual(h.seen.filter(value => value.stage === "preflight").map(value => [value.library, value.identity]),
        [[a, recordIdentity(first)], [b, recordIdentity(second)]]);
      assert.deepEqual(h.notices, []);
    } finally { await h.close(); }
  }
  {
    const h = await fixture();
    try {
      await h.start(); h.select(a); h.choices.remember(h.ctx, first);
      await h.emit("input", { text: "$same-choice identical", source: "interactive", streamingBehavior: "followUp" });
      h.select(b); h.choices.remember(h.ctx, second);
      await h.emit("input", { text: "$same-choice identical", source: "interactive", streamingBehavior: "steer" });
      await h.addUser("$same-choice identical"); await h.context();
      assert.deepEqual(h.seen.filter(value => value.stage === "preflight").map(value => value.identity), [recordIdentity(second)],
        "Pi's steering priority must not consume an older identical follow-up receipt");
      await h.addUser("$same-choice identical"); await h.context();
      assert.deepEqual(h.seen.filter(value => value.stage === "preflight").map(value => [value.library, value.identity]), [[b, recordIdentity(second)], [a, recordIdentity(first)]]);
    } finally { await h.close(); }
  }
  {
    const h = await fixture();
    try {
      await h.start(); h.select(a); h.choices.remember(h.ctx, first);
      const text = "$same-choice resized", images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "ORIGINAL_PIXELS" }];
      await h.emit("input", { text, images, source: "interactive", streamingBehavior: "followUp" });
      h.select(b); h.choices.remember(h.ctx, second);
      const native = await h.addUser(text, images, { text: text + "\n\n[Image resized to fit model limits]",
        images: [{ type: "image", mimeType: "image/jpeg", data: "NORMALIZED_PIXELS" }] });
      const [result] = await h.context();
      assert.deepEqual(h.seen.filter(value => value.stage === "preflight").map(value => [value.library, value.identity, value.text, value.images]),
        [[a, recordIdentity(first), text, images]], "Native image normalization must not lose or rebind the admitted receipt");
      assert.ok(result && typeof result === "object" && "messages" in result && Array.isArray(result.messages));
      assert.ok(result.messages.some(message => JSON.stringify(message) === JSON.stringify(native)), "Normalized native text and image content reach the model unchanged");
      await h.context();
      assert.equal(h.seen.filter(value => value.stage === "preflight").length, 1, "A repeated projection cannot consume the same message twice");
      assert.deepEqual(h.notices, []);
    } finally { await h.close(); }
  }
  for (const lifecycle of ["branch", "tree", "switch"] as const) {
    const h = await fixture();
    try {
      await h.start(); h.choices.remember(h.ctx, first);
      await h.emit("input", { text: "$same-choice retired", source: "interactive", streamingBehavior: "followUp" });
      await h.emit("session_before_" + lifecycle);
      h.replaceSession(); await h.emit("session_" + lifecycle);
      await h.emit("agent_start"); await h.addUser("$same-choice retired"); await h.context();
      assert.deepEqual(h.seen, [], "Retired queued input cannot bind a replacement lifecycle");
    } finally { await h.close(); }
  }
}

const root = await mkdtemp(join(tmpdir(), "broker-accepted-"));
try {
  const selectedRoot = join(root, "selected (设计)"), otherRoot = join(root, "other");
  await mkdir(selectedRoot);
  await mkdir(otherRoot);
  await writeFile(join(selectedRoot, "SKILL.md"), "---\nname: selected-skill\ndescription: Selected reference\n---\nSelected body.");
  await writeFile(join(otherRoot, "SKILL.md"), "---\nname: other-skill\ndescription: Other reference\n---\nOther body.");
  const selected = skillRecordFromFile(join(selectedRoot, "SKILL.md"), false)!;
  const other = skillRecordFromFile(join(otherRoot, "SKILL.md"), false)!;
  const notices: string[] = [];
  const ctx: ExtensionContext = { cwd: root, sessionManager: { getSessionId: () => "chosen", getEntries: () => [] }, ui: { notify: text => notices.push(text) } };
  const second: ExtensionContext = { cwd: root, sessionManager: { getSessionId: () => "other-session" } };
  const selections = createAcceptedSelections<DiscoveryRecord>(recordToken);
  const fallback: AutocompleteProvider = {
    async getSuggestions() { return null; },
    applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
  };
  const provider = createDollarSkillAutocompleteProvider(fallback, completionMenu([selected]),
    candidate => { if (candidate.origin === "local") selections.remember(ctx, candidate.record); });
  const suggestions = await provider.getSuggestions(["$selected"], 0, 9);
  assert.equal(selections.forContext(ctx).size, 0, "Displaying candidates does not accept them");
  const choice = suggestions!.items[0]!;
  const changed = provider.applyCompletion(["$selected"], 0, 9, choice, "$selected");
  assert.equal(changed.lines[0], "$selected-skill ");
  assert.equal(recordIdentity(selections.forContext(ctx).get("selected-skill")!), recordIdentity(selected));
  assert.equal(selections.forContext(second).size, 0, "Another session cannot inherit the selection");

  const submission = createInputReceipt({ text: "$selected-skill" }, ctx);
  selections.capture(submission, ["selected-skill"]);
  assert.equal(selections.forContext(ctx).size, 0, "Submission consumes the draft choice before asynchronous preparation");
  await rename(join(selectedRoot, "SKILL.md"), join(root, "retained-selected-SKILL.md"));
  const prompt = "$selected-skill $other-skill $ordinary-unknown keep the original material";
  const result = await invokeBeforeAgentStart({ prompt, systemPrompt: "" }, ctx, Promise.resolve([]), { pathMode: "hash" }, Promise.resolve([other]), undefined, undefined, {}, selections.forSubmission(submission));
  assert.match(String(result?.message?.content), /context-broker-unavailable/);
  assert.match(String(result?.message?.content), /Other body/);
  assert.doesNotMatch(String(result?.message?.content), /Selected body/);
  assert.equal(String(result?.message?.content).includes(root), false, "Unavailable feedback must not expose local identity/ref paths beside redacted loaded content");
  assert.equal(hasLoadedSkill([{ role: "custom", ...result!.message! }], selected), false, "Unavailable metadata is never a loaded receipt");
  assert.ok(notices.some(notice => notice.includes("not loaded") && notice.includes("selected-skill")));
  assert.equal(prompt, "$selected-skill $other-skill $ordinary-unknown keep the original material");

  const messages = [{ role: "user" as const, content: prompt }, { role: "custom" as const, ...result!.message! }];
  await writeFile(join(selectedRoot, "SKILL.md"), "---\nname: selected-skill\ndescription: Selected reference\n---\nRestored body.");
  const repeated = await invokeForContext({ messages }, Promise.resolve([]), {}, Promise.resolve([selected, other]));
  assert.equal(repeated, undefined, "Repeated context observes this submission's unavailable receipt without re-reading or adding another explanation");
  const retry = await invokeForContext({ messages: [...messages, { role: "user", content: "$selected-skill retry" }] }, Promise.resolve([]), {}, Promise.resolve([selected, other]));
  assert.match(JSON.stringify(retry), /Restored body/, "The next user submission may retry; an unavailable receipt never means loaded");

  const manual = await completeDollarRequest({ version: 1, text: "$selected", cursor: 9, cwd: root }, { skillRoots: [selectedRoot, otherRoot] });
  const manualChoice = manual.items.find(item => item.identity === recordIdentity(selected))!;
  assert.equal(manualChoice.value, "$" + preciseRecordToken(selected));
  assert.equal(matchDiscoveryRecord(manualChoice.value.slice(1), [selected]).decision, "inject");
  assert.equal(matchDiscoveryRecord(manualChoice.value.slice(1), [{ ...selected, name: "renamed", alias: "renamed", normalizedName: "renamed" }]).decision, "inject", "Canonical identity survives an alias rename");
  notices.length = 0;
  const unavailableManual = await invokeBeforeAgentStart({ prompt: manualChoice.value + " $other-skill", systemPrompt: "" }, ctx, Promise.resolve([]), {}, Promise.resolve([other]));
  assert.match(JSON.stringify(unavailableManual), /catalog-unavailable/);
  assert.match(String(unavailableManual?.message?.content), /Unavailable in the current catalog; not loaded/);
  assert.doesNotMatch(String(unavailableManual?.message?.content), /Not found; not loaded/);
  assert.ok(notices.some(text => text.includes("not loaded")));
  const spoof = { ...selected, name: "ntn-skills", alias: "ntn-skills", source: "notion" as const, sourceId: "configured-builtin", token: "builtin/ntn-skills", selectionToken: "ntn-skills@builtin", id: "skill://entry?library=00134658-9358-58ee-8efb-37ceff5ad74c", enabled: true, ref: "skill://entry/SKILL.md?library=00134658-9358-58ee-8efb-37ceff5ad74c", locator: { type: "shared_skill" as const, library_id: "00134658-9358-58ee-8efb-37ceff5ad74c", skill_id: "entry", page_id: "11111111-1111-4111-8111-111111111111", database_id: "22222222-2222-4222-8222-222222222222", data_source_id: "33333333-3333-4333-8333-333333333333" } };
  assert.equal(matchDiscoveryRecord("ntn-skills@builtin", [spoof]).decision, "skip", "A configured source cannot impersonate a missing official bundled Skill");
  assert.equal(matchDiscoveryRecord(preciseRecordToken(spoof), [spoof]).decision, "inject", "The configured source still has an exact independent target");

  selections.clear(ctx);
  assert.equal(selections.forContext(ctx).size, 0);
  notices.length = 0;
  const literal = await invokeBeforeAgentStart({ prompt: "$selected-skill $ordinary-unknown $ordinary-unknown@namespace $10 $1.25 $bunfs/root/chunks/example.js", systemPrompt: "" }, ctx, Promise.resolve([]), {}, Promise.resolve([other]));
  assert.equal(literal, undefined, "An unknown token without an accepted identity remains ordinary text");
  assert.deepEqual(notices, []);
  // Both real host submission modes use the existing preparation gate's synchronous boundary.
  for (const mode of ["command", "transform"] as const) {
    type Listener = (event: never, context: ExtensionContext) => unknown;
    const events = new Map<string, Listener>();
    const commands = new Map<string, { handler(args: string, context: ExtensionContext): unknown }>();
    const queued: string[] = [];
    const choices = createAcceptedSelections<DiscoveryRecord>(recordToken);
    const first = { ...selected, selectionToken: "same-choice" };
    const secondChoice = { ...other, selectionToken: "same-choice" };
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let pause = true;
    const seen: string[] = [];
    const context: ExtensionContext = { ...ctx, mode: "tui" };
    const readChoice = (receipt?: InputReceipt): DiscoveryRecord => choices.forSubmission(receipt).get("same-choice")!;
    const api: ExtensionAPI = {
      on(name, handler) { events.set(name, handler as unknown as Listener); },
      registerCommand(name, command) { commands.set(name, command); },
      sendUserMessage(content) { assert.equal(typeof content, "string"); queued.push(content as string); },
    };
    const adapter: HostCapabilities = {
      paths: {}, submission: { mode, receipt: mode === "command" ? "handoff" : "input-digest" },
      handledInput: { handled: true }, continuedInput: undefined, transformInput: text => ({ text }),
      registerCatalog: async () => true, installEditor: async () => {}, reload: async () => {}, updatedRead: input => ({ input }),
      buildPrompt: async () => { throw Error("No native Skill expansion in this boundary check"); },
    };
    const host = await installHostSkills(api, {
      config: {}, getRecords: async () => ({ records: [], failures: [] }),
      loadRecord: async () => { throw Error("No source activation in this ownership check"); },
      needsPreflightPrompt: text => text.includes("$same-choice"),
      onInputReceipt: receipt => choices.capture(receipt, ["same-choice"]),
      preflightPrompt: async (_text, _ctx, _signal, receipt) => {
        const owned = recordIdentity(readChoice(receipt));
        if (pause) { started.resolve(); await release.promise; }
        assert.equal(recordIdentity(readChoice(receipt)), owned, "Editing the next draft cannot change a preparing submission");
        seen.push(owned);
      },
      taskPrompt: async (text, _ctx, _signal, invocation) => { seen.push(recordIdentity(readChoice(invocation?.receipt))); return text; },
    }, adapter);
    const emit = (name: string, event: unknown) => events.get(name)!(event as never, context);
    const begin = async (text: string) => {
      const input = await emit("input", { text, source: "rpc" });
      if (mode === "command") {
        assert.ok(input && typeof input === "object" && "text" in input);
        await commands.get("context-broker-submit")!.handler(String(input.text).split(" ")[1]!, context);
      }
    };
    choices.remember(context, first);
    const preparing = begin("$same-choice submission A");
    await started.promise;
    choices.remember(context, secondChoice);
    release.resolve();
    await preparing;
    const submittedA = mode === "command" ? queued.at(-1)! : "$same-choice submission A";
    await emit("before_agent_start", { prompt: submittedA, systemPrompt: "" });
    await host.withPreparedPrompt(submittedA, context, async (_signal, _native, _original, _prepared, receipt) => { assert.equal(recordIdentity(readChoice(receipt)), recordIdentity(first), "The final injection consumer retains A's accepted identity"); });
    await emit("agent_start", {});
    choices.remember(context, secondChoice);
    await emit("agent_end", {});
    assert.equal(recordIdentity(choices.forContext(context).get("same-choice")!), recordIdentity(secondChoice), "A ending cannot clear B's draft choice");
    assert.deepEqual(seen, [recordIdentity(first), recordIdentity(first)]);
    pause = false;
    await begin("$same-choice submission B");
    assert.deepEqual(seen.slice(2), [recordIdentity(secondChoice), recordIdentity(secondChoice)], "B consumes its own identity after A finishes");
    await emit("session_shutdown", {});
  }
  await deferredInputReceipts(selected, other, root);
  console.log("accepted selection checks passed: independent input receipts, Pi composed signals and queues, per-message Library and images, steering order, lifecycle retirement, exact manual tokens and ordinary text");
} finally {
  await rename(root, root + ".retained");
}
