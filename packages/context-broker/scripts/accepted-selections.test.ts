import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAcceptedSelections } from "../src/accepted-selections";
import { createDollarSkillAutocompleteProvider } from "../src/dollar";
import { recordIdentity, preciseRecordToken } from "../src/discovery-records";
import { completeDollarRequest } from "../src/completion";
import { installHostSkills } from "../src/host-skills";
import { hasLoadedSkill, invokeBeforeAgentStart, invokeForContext, matchDiscoveryRecord } from "../src/index";
import { skillRecordFromFile } from "../src/skill-records";
import type { AutocompleteProvider, ExtensionContext, ExtensionAPI, DiscoveryRecord } from "../src/types";
import type { HostCapabilities } from "../src/host-adapter";

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
  const selections = createAcceptedSelections();
  const fallback: AutocompleteProvider = {
    async getSuggestions() { return null; },
    applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
  };
  const provider = createDollarSkillAutocompleteProvider(fallback, Promise.resolve([selected]), record => selections.remember(ctx, record));
  const suggestions = await provider.getSuggestions(["$selected"], 0, 9);
  assert.equal(selections.forContext(ctx).size, 0, "Displaying candidates does not accept them");
  const choice = suggestions!.items[0]!;
  const changed = provider.applyCompletion(["$selected"], 0, 9, choice, "$selected");
  assert.equal(changed.lines[0], "$selected-skill ");
  assert.equal(recordIdentity(selections.forContext(ctx).get("selected-skill")!), recordIdentity(selected));
  assert.equal(selections.forContext(second).size, 0, "Another session cannot inherit the selection");

  const submission = new AbortController();
  selections.capture(ctx, submission.signal, ["selected-skill"]);
  assert.equal(selections.forContext(ctx).size, 0, "Submission consumes the draft choice before asynchronous preparation");
  await rm(join(selectedRoot, "SKILL.md"));
  const prompt = "$selected-skill $other-skill $ordinary-unknown keep the original material";
  const result = await invokeBeforeAgentStart({ prompt, systemPrompt: "" }, ctx, Promise.resolve([]), { pathMode: "hash" }, Promise.resolve([other]), undefined, undefined, {}, selections.forSubmission(submission.signal));
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
  const spoof = { ...selected, name: "ntn-skills", alias: "ntn-skills", source: "notion" as const, sourceId: "configured-builtin", token: "builtin/ntn-skills", selectionToken: "ntn-skills@builtin", id: "notion_page:11111111-1111-1111-1111-111111111111", locator: { type: "notion_page" as const, page_id: "11111111-1111-1111-1111-111111111111", database_id: "22222222-2222-2222-2222-222222222222", data_source_id: "33333333-3333-3333-3333-333333333333" } };
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
    const choices = createAcceptedSelections();
    const first = { ...selected, selectionToken: "same-choice" };
    const secondChoice = { ...other, selectionToken: "same-choice" };
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let pause = true;
    const seen: string[] = [];
    const context: ExtensionContext = { ...ctx, mode: "tui" };
    const readChoice = (signal?: AbortSignal): DiscoveryRecord => choices.forSubmission(signal).get("same-choice")!;
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
      onPreparation: entry => choices.capture(entry.ctx, entry.controller.signal, ["same-choice"]),
      preflightPrompt: async (_text, _ctx, signal) => {
        const owned = recordIdentity(readChoice(signal));
        if (pause) { started.resolve(); await release.promise; }
        assert.equal(recordIdentity(readChoice(signal)), owned, "Editing the next draft cannot change a preparing submission");
        seen.push(owned);
      },
      taskPrompt: async (text, _ctx, signal) => { seen.push(recordIdentity(readChoice(signal))); return text; },
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
    await host.withPreparedPrompt(submittedA, context, async signal => { assert.equal(recordIdentity(readChoice(signal)), recordIdentity(first), "The final injection consumer retains A's accepted identity"); });
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
  console.log("accepted selection checks passed: gate-owned acceptance across concurrent drafts, session isolation, exact manual tokens, model/UI missing feedback, per-submission retry, ordinary unknown text");
} finally {
  await rm(root, { recursive: true, force: true });
}
