import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "bun:test";
import type { InputReceipt } from "../src/skill-preparation";
import type { HostCapabilities } from "../src/host-adapter";
import type { AgentMessage, ConfigFile, ExtensionAPI, ExtensionContext, ImageContent } from "../src/types";

const brokerRoot = process.env.PI_QUEUED_INPUT_BROKER ?? fileURLToPath(new URL("..", import.meta.url));
const { createAcceptedSelections } = await import(pathToFileURL(join(brokerRoot, "src/accepted-selections.ts")).href) as typeof import("../src/accepted-selections");
const { installHostSkills } = await import(pathToFileURL(join(brokerRoot, "src/host-skills.ts")).href) as typeof import("../src/host-skills");
const { createLibrarySelection, libraryContext, LIBRARY_SELECTION_ENTRY } = await import(pathToFileURL(join(brokerRoot, "src/library-selection.ts")).href) as typeof import("../src/library-selection");

const packageRoot = process.env.PI_QUEUED_INPUT_PACKAGE;
assert.ok(packageRoot, "Set PI_QUEUED_INPUT_PACKAGE to the installed Pi package root");
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
const { AgentSession } = await import(pathToFileURL(join(packageRoot, "dist/core/agent-session.js")).href);
const { SessionManager } = await import(pathToFileURL(join(packageRoot, "dist/core/session-manager.js")).href);
const { ExtensionRunner } = await import(pathToFileURL(join(packageRoot, "dist/core/extensions/runner.js")).href);

test("installed Pi " + manifest.version + " retains queued receipts across real image normalization and cloned context", async () => {
  const uuid = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  const a = uuid(1), b = uuid(2), cwd = process.cwd();
  const manager = SessionManager.inMemory(cwd);
  type Listener = (event: never, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Listener[]>(), notices: string[] = [], receipts: InputReceipt[] = [];
  const choices = createAcceptedSelections<{ token: string; target: string }>(candidate => candidate.token);
  const budgets: unknown[] = [];
  const seen: Array<{ id: string; target: string; library: string | undefined; images: ImageContent[] | undefined }> = [];
  const config: ConfigFile = { sources: [{ id: "a", type: "notion", library: a }, { id: "b", type: "notion", library: b }] };
  const owner = createLibrarySelection(config, async input => {
    const table = (n: number) => ({ database_id: uuid(n), data_source_id: uuid(n + 1), property_ids: {} });
    return { version: 2, library_id: input.library!, operation_id: "fixture", skills: table(10), files: table(20), records: table(30), sources: table(40) };
  }, async input => input.library ?? a);
  const ctx: ExtensionContext = { cwd, mode: "tui", sessionManager: manager, signal: new AbortController().signal,
    ui: { notify: message => notices.push(message) } };
  const api: ExtensionAPI = { on(name, handler) { handlers.set(name, [...handlers.get(name) ?? [], handler as unknown as Listener]); }, registerCommand() {} };
  const adapter: HostCapabilities = { paths: { host: "pi" }, metadataDiscovery: "deferred", submission: { mode: "transform", receipt: "handoff" },
    handledInput: { action: "handled" }, continuedInput: { action: "continue" }, transformInput: (text, images) => ({ action: "transform", text, images }),
    registerCatalog: async () => false, installEditor: async () => {}, reload: async () => {}, updatedRead: input => ({ input }),
    buildPrompt: async () => { throw new Error("No native expansion in receipt replay"); } };
  await installHostSkills(api, { config, librarySelection: owner,
    getRecords: async () => ({ records: [], failures: [] }), loadRecord: async () => { throw new Error("No content read in receipt replay"); },
    needsPreflightPrompt: text => text.includes("$same-choice"),
    onInputReceipt: receipt => { receipts.push(receipt); choices.capture(receipt, ["same-choice"]); },
    preflightPrompt: async (_text, context, _signal, receipt, budget) => {
      assert.ok(budget); budgets.push(budget);
      assert.ok(receipt);
      const selected = choices.forSubmission(receipt).get("same-choice"); assert.ok(selected);
      seen.push({ id: receipt.id, target: selected.target, library: libraryContext(context)?.local()?.root, images: receipt.event.images });
    },
  }, adapter);
  // Reuse the installed event dispatcher and SessionManager, including their
  // actual clone/provenance boundary; only the provider and UI are unnecessary.
  const runner = Object.assign(Object.create(ExtensionRunner.prototype), {
    extensions: [{ path: "queued-input-replay", handlers }], createContext: () => ctx,
    emitError: (error: unknown) => { throw new Error(JSON.stringify(error)); },
  });
  const normalizer = Object.assign(Object.create(AgentSession.prototype), {
    settingsManager: { getImageAutoResize: () => true },
    _limitsModel: () => ({ inputLimits: { images: { resize: { maxWidth: 1, maxHeight: 1 } } } }),
  });
  const text = "$same-choice with image";
  const image: ImageContent = { type: "image", mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=" };
  try {
    await runner.emit({ type: "agent_start" });
    const initial: AgentMessage = { role: "user", content: "running" };
    await runner.emit({ type: "message_start", message: initial }); manager.appendMessage(initial);
    await runner.emitContext(manager.buildSessionProjection().messages);
    manager.appendCustomEntry(LIBRARY_SELECTION_ENTRY, { version: 1, library: a, status: "ready" }); owner.invalidate();
    choices.remember(ctx, { token: "same-choice", target: "accepted-A" });
    await runner.emitInput(text, [image], "interactive", "followUp");
    manager.appendCustomEntry(LIBRARY_SELECTION_ENTRY, { version: 1, library: b, status: "ready" }); owner.invalidate();
    choices.remember(ctx, { token: "same-choice", target: "next-draft-B" });
    const secondText = "$same-choice second queued input";
    await runner.emitInput(secondText, undefined, "interactive", "followUp");
    choices.remember(ctx, { token: "same-choice", target: "later-draft-B" });
    const native: AgentMessage = { role: "user", content: [{ type: "text", text }, { ...image }] };
    await normalizer._normalizeQueuedMessageImages(native);
    assert.ok(Array.isArray(native.content));
    const normalizedImage = native.content.find(part => part.type === "image");
    assert.ok(normalizedImage, "The installed image pipeline must actually produce an image");
    assert.notEqual(normalizedImage.data, image.data, "The real resize changes image bytes");
    assert.notEqual(native.content[0]!.text, text, "The real queued normalization appends a size hint");
    await runner.emit({ type: "message_start", message: native });
    const entryId = manager.appendMessage(native);
    const second: AgentMessage = { role: "user", content: secondText };
    await runner.emit({ type: "message_start", message: second }); manager.appendMessage(second);
    const projection = manager.buildSessionProjection();
    assert.equal(projection.entries.find((entry: { sourceEntry: { id: string } }) => entry.sourceEntry.id === entryId)?.sourceEntry.message, native,
      "Actual SessionManager retains the message_start instance as provenance");
    const projected = await runner.emitContext(projection.messages);
    assert.deepEqual(seen, [{ id: receipts[0]!.id, target: "accepted-A", library: a, images: [image] },
      { id: receipts[1]!.id, target: "next-draft-B", library: b, images: undefined }]);
    assert.equal(budgets.length, 2);
    assert.equal(budgets[0], budgets[1], "Both accepted queued inputs share the same context budget");
    const delivered = projected.find((message: AgentMessage) => message.role === "user" && Array.isArray(message.content));
    assert.notEqual(delivered, native, "Actual emitContext clones the messages before Broker sees them");
    assert.deepEqual(delivered, native, "Broker preserves Pi's normalized text and image bytes");
    await runner.emitContext(manager.buildSessionProjection().messages);
    assert.equal(seen.length, 2, "Repeated context cannot adopt the same native occurrence twice");
    assert.equal(choices.forContext(ctx).get("same-choice")?.target, "later-draft-B");
    assert.deepEqual(notices, []);
  } finally { await runner.emit({ type: "session_shutdown" }); }
});
