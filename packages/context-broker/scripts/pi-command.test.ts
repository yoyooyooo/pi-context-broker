import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isolatedEnv } from "./context-broker-e2e-fixture.mjs";
import type { AutocompleteProvider, AutocompleteSuggestions, EditorFactory, ImageContent, InputResult } from "../src/types";

type ManagementDetails = { output: string; argv?: string[]; [key: string]: unknown };
type ReceiptMessage = { customType: string; content: unknown; display: boolean; details: ManagementDetails };
type RegisteredCommand = { name: string; description?: string; getArgumentCompletions?: (prefix: string) => Promise<AutocompleteSuggestions["items"] | null> };
type PiInputResult = Extract<InputResult, { action: string }>;
type CliCall = { argv: string[]; executable: string; cwd: string };
// This is a consumer test of the selected installed official Pi. No broker runtime
// module is imported directly: its entire independent source snapshot goes through
// Pi's official TypeScript extension loader, including its bundled save workflow.
const hostRoot = process.env.PI_COMMAND_TEST_HOST_ROOT;
assert.ok(hostRoot, "Set PI_COMMAND_TEST_HOST_ROOT to the installed official Pi package root");
const evidence = await mkdtemp(join(tmpdir(), "pi-command-official-"));
const tracePath = join(evidence, "editor-provider-events.jsonl");
const callsPath = join(evidence, "cli-argv.jsonl");
const snapshot = join(evidence, "broker");
const cwd = join(evidence, "project");
const brokerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(cwd, { recursive: true });
await mkdir(snapshot);
await cp(join(brokerRoot, "src"), join(snapshot, "src"), { recursive: true, dereference: true });
await cp(join(brokerRoot, "package.json"), join(snapshot, "package.json"));
// Keep a separate package-resolution boundary: never add host aliases to the
// developer installation. Individual dependency links retain their real package
// locations (including workspace dependencies); host packages come from the
// explicitly selected official Pi installation, including dynamic TUI imports.
const snapshotModules = join(snapshot, "node_modules");
await mkdir(snapshotModules);
for (const name of await readdir(join(brokerRoot, "node_modules"))) {
  if (name.startsWith(".")) continue;
  if (name.startsWith("@")) {
    await mkdir(join(snapshotModules, name));
    for (const member of await readdir(join(brokerRoot, "node_modules", name))) {
      if (name === "@earendil-works" && ["pi-coding-agent", "pi-tui"].includes(member)) continue;
      await symlink(await realpath(join(brokerRoot, "node_modules", name, member)), join(snapshotModules, name, member), "dir");
    }
  } else {
    await symlink(await realpath(join(brokerRoot, "node_modules", name)), join(snapshotModules, name), "dir");
  }
}
await mkdir(join(snapshotModules, "@earendil-works"), { recursive: true });
await symlink(hostRoot, join(snapshotModules, "@earendil-works/pi-coding-agent"), "dir");
await symlink(join(hostRoot, "node_modules/@earendil-works/pi-tui"), join(snapshotModules, "@earendil-works/pi-tui"), "dir");
const entry = join(snapshot, "src/index.ts");
const configPath = join(evidence, "context-broker.json");
const cli = join(evidence, "cli.mjs");
const cliCommand = [process.execPath, cli];
const schema = { name: "ntn-skills", parameters: [], commands: [
  { name: "ctl", parameters: [], commands: [
    { name: "status", parameters: [{ name: "json", kind: "flag" }, { name: "verbose", kind: "flag" }], commands: [] },
    { name: "doctor", parameters: [], commands: [] },
  ] },
  { name: "read", parameters: [{ name: "target", kind: "argument", required: true }], commands: [] },
  { name: "sync", parameters: [], commands: [
    { name: "local", parameters: [], commands: [
      { name: "run", parameters: [{ name: "target", kind: "argument", required: true }], commands: [] },
    ] },
  ] },
] };
const targetRef = "skill://11111111-1111-4111-8111-111111111111/PROMPT.md";
const database = "33333333-3333-4333-8333-333333333333";
const dataSource = "44444444-4444-4444-8444-444444444444";
const targetRecord = {
  id: "notion_page:11111111-1111-4111-8111-111111111111", kind: "prompt",
  locator: { type: "notion_page", page_id: "11111111-1111-4111-8111-111111111111", database_id: database, data_source_id: dataSource },
  name: "UI Alpha", alias: "ui-alpha", description: "Public management target fixture", default_context: false,
  entrypoint: "PROMPT.md", ref: targetRef,
};
await writeFile(cli, `import {appendFileSync} from 'node:fs';
const argv=process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({argv,executable:process.execPath,cwd:process.cwd()})+'\\n');
if(argv[0]==='schema') console.log(JSON.stringify({format:'effect-cli-schema',version:1,schema:${JSON.stringify(schema)}}));
else if(argv[0]==='--version') console.log('pi-command-fixture 1.0.0');
else if(argv[0]==='list') console.log(JSON.stringify({ok:true,scope:'b'.repeat(64),source:'notion',fetched_at:Date.now(),records:[${JSON.stringify(targetRecord)}],count:1,databases:[{database_id:${JSON.stringify(database)},title:'Fixture',alias:'fixture',data_source_ids:[${JSON.stringify(dataSource)}]}],coverage:{method:'search_and_registered',exhaustive:true,search_index_limited:false,queried_data_sources:[${JSON.stringify(dataSource)}],failed_sources:[]},freshness:{policy:'max_age',validated_at:new Date().toISOString(),age_ms:0,max_age_ms:60000,stale:false}}));
else if(argv[0]==='ctl' || argv[0]==='read' || argv[0]==='sync') console.log(JSON.stringify({ok:true,argv}));
else { console.error('Unexpected fixture argv: '+JSON.stringify(argv)); process.exitCode=1; }
`);
await writeFile(configPath, JSON.stringify({
  skillRoots: [], ruleRoots: [], discoveryCatalogs: [], extraDiscoveryCatalogs: [],
  sources: [{ id: "test", type: "notion", command: cliCommand, cacheDir: join(evidence, "source-cache") }],
}));
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const isolated = isolatedEnv({ base: join(evidence, "home"), agentDir: join(evidence, "agent"), CONTEXT_BROKER_HOST: "pi", CONTEXT_BROKER_CONFIG: configPath });
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolated);
process.chdir(cwd);
let sequence = 0;
let scenario = "setup";
function record(event: string, details: Record<string, unknown> = {}) {
  appendFileSync(tracePath, JSON.stringify({ sequence: ++sequence, scenario, event, ...details }) + "\n");
}
const hostImport = (relative: string) => import(pathToFileURL(join(hostRoot!, relative)).href);

try {
  const [{ loadExtensions }, { ExtensionRunner }, { SessionManager }, { Editor }, { CombinedAutocompleteProvider }, { InteractiveMode }, { getKeybindings }] = await Promise.all([
    hostImport("dist/core/extensions/loader.js"), hostImport("dist/core/extensions/runner.js"),
    hostImport("dist/core/session-manager.js"),
    hostImport("node_modules/@earendil-works/pi-tui/dist/components/editor.js"),
    hostImport("node_modules/@earendil-works/pi-tui/dist/autocomplete.js"),
    hostImport("dist/modes/interactive/interactive-mode.js"),
    hostImport("node_modules/@earendil-works/pi-tui/dist/keybindings.js"),
  ]);
  const loaded = await loadExtensions([entry], cwd);
  record("official-load", { entry, errors: loaded.errors, warnings: loaded.warnings, extensionPaths: loaded.extensions.map((extension: { path: string }) => extension.path) });
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({ role: "user", content: "Existing conversation must survive save", timestamp: 1 });
  const errors: unknown[] = [];
  const receipts: Array<{ message: ReceiptMessage; options: { triggerTurn?: boolean } }> = [];
  const userMessages: unknown[] = [];
  const restoredDrafts: string[] = [];
  const notifications: Array<{ text: string; kind: string }> = [];
  const submissions: string[] = [];
  const inputResults: Array<{ text: string; result: PiInputResult }> = [];
  const currentAgentRequests: Array<{ text: string; images?: ImageContent[] }> = [];
  const nativeSettings: string[] = [];
  const pendingSubmits = new Set<Promise<void>>();
  let aborts = 0;
  // No model registry methods are used by this extension. Actual current-Agent
  // requests stop at the explicit collector below, so no credentials/network exist.
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, undefined);
  runner.onError((error: unknown) => { errors.push(error); record("extension-error", { error }); });
  runner.bindCore({
    sendMessage(message: ReceiptMessage, options: { triggerTurn?: boolean } = {}) {
      receipts.push({ message, options });
      sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      record("extension-message", { message, options });
    },
    sendUserMessage(content: unknown, options: unknown) { userMessages.push({ content, options }); record("sendUserMessage", { content, options }); },
    appendEntry(type: string, data: unknown) { sessionManager.appendCustomEntry(type, data); record("append-entry", { type, data }); },
    setSessionName(name: string) { sessionManager.appendSessionInfo(name); },
    getSessionName: () => sessionManager.getSessionName(),
    setLabel() {}, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}),
    setActiveTools() {}, refreshTools: async () => {}, getCommands: () => runner.getRegisteredCommands(),
    setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel() {},
  }, {
    getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true,
    getSignal: () => undefined, abort() { aborts++; }, hasPendingMessages: () => false, shutdown() {},
    getContextUsage: () => undefined, compact() {}, getSystemPrompt: () => "Consumer fixture system prompt",
    getSystemPromptOptions: () => ({ cwd, forceSystemPrompt: "Consumer fixture system prompt" }),
  });

  const identity = (text: string) => text;
  const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
  const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} };
  type PublicEditor = {
    handleInput(data: string): void; setText(text: string): void; getText(): string;
    getCursor(): { line: number; col: number }; getLines(): string[]; isShowingAutocomplete(): boolean;
    render(width: number): string[]; setAutocompleteProvider(provider: AutocompleteProvider): void;
    onSubmit?: (text: string) => void; onChange?: (text: string) => void; disableSubmit: boolean;
  };
  let editor: PublicEditor = new Editor(tui, theme);
  const defaultEditor = editor;
  const initialFactory: EditorFactory = (tui, theme) => new Editor(tui, theme);
  let factory: EditorFactory | undefined = initialFactory;
  const providerFactories: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];
  const completed: Array<{ stage: string; text: string; result: AutocompleteSuggestions | null; aborted: boolean }> = [];
  const requests = new Set<Promise<unknown>>();
  let hold: { text: string; entered: Promise<void>; enter(): void; released: Promise<void>; release(): void } | undefined;
  function observe(current: AutocompleteProvider, stage: string): AutocompleteProvider {
    return {
      ...current,
      ...(current.shouldTriggerFileCompletion ? { shouldTriggerFileCompletion: current.shouldTriggerFileCompletion.bind(current) } : {}),
      getSuggestions(lines, line, column, options, partial) {
        const text = lines.join("\n");
        const signal = options instanceof AbortSignal ? options : options?.signal;
        record("provider-request", { stage, text, line, column, force: options instanceof AbortSignal ? false : options?.force, aborted: signal?.aborted });
        const task = (async () => {
          const result = await current.getSuggestions(lines, line, column, options, partial);
          if (stage === "editor" && hold?.text === text) {
            const selected = hold;
            record("candidate-held", { text, prefix: result?.prefix, items: result?.items });
            selected.enter();
            await selected.released;
          }
          const value = { stage, text, result, aborted: signal?.aborted ?? false };
          completed.push(value);
          record("provider-result", value);
          return result;
        })();
        requests.add(task);
        void task.finally(() => requests.delete(task)).catch(() => {});
        return task;
      },
      applyCompletion(lines, line, column, item, prefix) {
        const result = current.applyCompletion(lines, line, column, item, prefix);
        record("provider-apply", { stage, text: lines.join("\n"), line, column, item, prefix, result });
        return result;
      },
    };
  }
  let provider: AutocompleteProvider;
  function rebuildProviders() {
    const commands = [{ name: "settings", description: "Open native Pi settings" }, ...runner.getRegisteredCommands().map((command: RegisteredCommand) => ({ name: command.name, description: command.description, getArgumentCompletions: command.getArgumentCompletions }))];
    let next = observe(new CombinedAutocompleteProvider(commands, cwd, null), "native");
    for (const [index, wrap] of providerFactories.entries()) next = observe(wrap(next), `extension-${index + 1}`);
    provider = observe(next, "editor");
    defaultEditor.setAutocompleteProvider(provider);
    if (editor !== defaultEditor) editor.setAutocompleteProvider(provider);
  }
  // Real InteractiveMode.setupEditorSubmitHandler supplies native /settings
  // dispatch BEFORE extension input handling. Only its terminal collaborators and
  // normal queued-input consumer are driver fixtures; no handler is reimplemented.
  const driver = {
    defaultEditor, get editor() { return editor; }, session: { isCompacting: false, isStreaming: false },
    pendingUserInputs: [] as string[], flushPendingBashComponents() {},
    showSettingsSelector() { nativeSettings.push(editor.getText()); record("native-settings"); },
    onInputCallback(text: string) {
      const images = nextImages;
      nextImages = undefined;
      const task = (async () => {
        const result = await runner.emitInput(text, images, "interactive");
        inputResults.push({ text, result });
        record("input-result", { text, images, result });
        if (result.action !== "handled") {
          const request = { text: result.action === "transform" ? result.text : text, images: result.action === "transform" ? result.images : images };
          currentAgentRequests.push(request);
          record("current-agent-request", request);
        }
      })();
      pendingSubmits.add(task);
      void task.finally(() => pendingSubmits.delete(task)).catch(() => {});
    },
  };
  let nextImages: ImageContent[] | undefined;
  InteractiveMode.prototype.setupEditorSubmitHandler.call(driver);
  const nativeSubmit = defaultEditor.onSubmit!;
  defaultEditor.onSubmit = text => { submissions.push(text); record("editor-submit", { text }); nativeSubmit(text); };
  runner.setUIContext({
    notify(text: string, kind: string) { notifications.push({ text, kind }); record("notify", { text, kind }); },
    setWidget(key: string, content: unknown) { record("widget", { key, visible: content !== undefined }); },
    getEditorText: () => editor.getText(),
    setEditorText(text: string) { restoredDrafts.push(text); editor.setText(text); record("restore-draft", { text }); },
    getEditorComponent: () => factory,
    setEditorComponent(next: EditorFactory | undefined) {
      factory = next;
      const previous = editor;
      editor = (next ? next(tui, theme, getKeybindings()) : defaultEditor) as PublicEditor;
      editor.onSubmit = defaultEditor.onSubmit;
      editor.onChange = previous.onChange;
      editor.setText(previous.getText());
      if (provider) editor.setAutocompleteProvider(provider);
      record("editor-factory-installed", { isOriginal: next === initialFactory, isInstalledEditor: editor instanceof Editor });
    },
    addAutocompleteProvider(wrap: (current: AutocompleteProvider) => AutocompleteProvider) {
      providerFactories.push(wrap);
      rebuildProviders();
      record("provider-factory-added", { count: providerFactories.length });
    },
  }, "tui");
  rebuildProviders();
  await runner.emit({ type: "session_start" });
  assert.ok(factory && factory !== initialFactory, "Full entry must install its preparation/editor wrapper");
  assert.ok(editor instanceof Editor);
  assert.equal(providerFactories.length, 2, "Both full-entry dollar and management providers must wrap native Pi completion");

  function state(label: string) {
    record("editor-state", { label, text: editor.getText(), cursor: editor.getCursor(), menu: editor.isShowingAutocomplete(), disabled: editor.disableSubmit, rendered: editor.render(100), submissions: submissions.length, currentAgentRequests: currentAgentRequests.length, nativeSettings: nativeSettings.length });
  }
  async function until(predicate: () => boolean, label: string) {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${label}; evidence: ${evidence}`);
      await delay(2);
    }
  }
  async function settle() {
    // Observe async provider completion through its public boundary, without
    // touching the Editor's private request task, popup, or selection state.
    await delay(0);
    await until(() => requests.size === 0 && pendingSubmits.size === 0, "public provider/submission settlement");
    await delay(0);
    state("settled");
  }
  function type(text: string) { for (const character of text) editor.handleInput(character); }
  async function draft(text: string) {
    // Public setText is used only to reset BETWEEN independent scenarios.
    // Every test draft itself is produced by ordinary public key input.
    editor.setText("");
    type(text);
    await settle();
    assert.equal(editor.getText(), text);
  }
  async function key(data: string) { editor.handleInput(data); await settle(); }
  function latest(text = editor.getText()) {
    const result = completed.findLast(value => value.stage === "editor" && value.text === text && !value.aborted);
    assert.ok(result, `No completed public provider request for ${JSON.stringify(text)}`);
    return result.result;
  }
  function values() { return latest()?.items.map(item => item.value) ?? []; }
  function ownedEmpty() {
    const result = latest();
    assert.ok(result, "Management must return an owned empty result, not native fallback null");
    assert.deepEqual(result.items, []);
    assert.equal(result.prefix.startsWith("/"), false);
    assert.equal(editor.isShowingAutocomplete(), false);
  }
  async function select(value: string, confirmation: "\r" | "\t", expected: string) {
    const choices = values();
    assert.ok(choices.includes(value), `Expected ${JSON.stringify(value)} in ${JSON.stringify(choices)}`);
    assert.equal(latest()!.prefix.startsWith("/"), false, "Management acceptance must remain draft-only");
    assert.equal(editor.isShowingAutocomplete(), true);
    const before = submissions.length;
    // These cases deliberately use one candidate (or the first candidate), so
    // acceptance exercises Pi's real initial selection without private APIs.
    assert.equal(choices[0], value);
    await key(confirmation);
    assert.equal(editor.getText(), expected);
    assert.equal(submissions.length, before, "Completion acceptance must only edit the draft");
  }
  function lastReceipt() {
    const receipt = receipts.findLast(receipt => receipt.message.customType === "ntn-skills-builtin");
    assert.ok(receipt);
    assert.equal(receipt.options.triggerTurn, false);
    return receipt.message.details;
  }
  async function submitExact(text: string, argv: string[]) {
    await draft(text);
    ownedEmpty();
    const before = submissions.length;
    const models = currentAgentRequests.length;
    await key("\r");
    assert.equal(submissions.length, before + 1);
    assert.equal(submissions.at(-1), text);
    assert.equal(inputResults.at(-1)!.result.action, "handled");
    assert.deepEqual(lastReceipt().argv, [...cliCommand, ...argv]);
    assert.match(lastReceipt().output, /Outcome: CLI receipt returned/);
    assert.equal(currentAgentRequests.length, models, "Management never reaches the model provider boundary");
    assert.equal(nativeSettings.length, 0);
  }

  scenario = "full-typed-status-one-enter";
  await submitExact("/ntn-skills ctl status", ["ctl", "status"]);

  scenario = "root-sync-local-run-draft-selection";
  await draft("/ntn");
  await select("ntn-skills ", "\r", "/ntn-skills ");
  // The completed root itself must show root children; no artificial trailing
  // character or Escape is needed to make it a management parent.
  await draft("/ntn-skills");
  assert.deepEqual(values(), ["ctl ", "read ", "sync ", "save "]);
  type(" sy"); await settle();
  assert.deepEqual(values(), ["sync "]);
  await select("sync ", "\t", "/ntn-skills sync ");
  type("lo"); await settle();
  assert.deepEqual(values(), ["sync local "]);
  await select("sync local ", "\r", "/ntn-skills sync local ");
  type("ru"); await settle();
  assert.deepEqual(values(), ["sync local run "]);
  await select("sync local run ", "\t", "/ntn-skills sync local run ");
  const beforeMissing = submissions.length;
  await key("\r");
  assert.equal(submissions.length, beforeMissing + 1);
  assert.equal(submissions.at(-1), "/ntn-skills sync local run");
  assert.equal(inputResults.at(-1)!.result.action, "handled");
  assert.match(lastReceipt().output, /HOST_TARGET_REQUIRED/);
  assert.equal(editor.getText(), "/ntn-skills sync local run");
  assert.equal(currentAgentRequests.length, 0);
  assert.equal(lastReceipt().argv, undefined, "Missing-target run is rejected before CLI execution");

  scenario = "partial-parent-next-child-only";
  await draft("/ntn-skills sync");
  assert.deepEqual(values(), ["sync local "]);
  await select("sync local ", "\r", "/ntn-skills sync local ");
  await draft("/ntn-skills sync local");
  assert.deepEqual(values(), ["sync local run "]);
  await select("sync local run ", "\r", "/ntn-skills sync local run ");

  scenario = "quoted-target-spaces-exact-argv";
  const spacedTarget = 'skill://exact/PROMPT.md?version=a b"c';
  await submitExact(`/ntn-skills read ${JSON.stringify(spacedTarget)}`, ["read", spacedTarget]);
  scenario = "quoted-run-target-exact-argv";
  await submitExact(`/ntn-skills sync local run ${JSON.stringify(spacedTarget)}`, ["sync", "local", "run", spacedTarget]);

  scenario = "catalog-target-selected-through-real-menu";
  await draft("/ntn-skills read ui");
  const selectedTargetValue = `read ${JSON.stringify(targetRef)} `;
  assert.deepEqual(values(), [selectedTargetValue]);
  await select(selectedTargetValue, "\r", `/ntn-skills ${selectedTargetValue}`);
  await key("\r");
  assert.deepEqual(lastReceipt().argv, [...cliCommand, "read", targetRef]);
  assert.equal(currentAgentRequests.length, 0);

  scenario = "exact-status-optional-flags-no-name-replacement";
  await submitExact("/ntn-skills ctl status --json --verbose", ["ctl", "status", "--json", "--verbose"]);

  scenario = "settled-partial-popup-immediate-exact-enter";
  await draft("/ntn-skills ctl st");
  assert.deepEqual(values(), ["ctl status "]);
  assert.equal(editor.isShowingAutocomplete(), true);
  const beforeImmediate = submissions.length;
  type("atus");
  state("exact-text-before-pending-result");
  editor.handleInput("\r");
  await settle();
  assert.equal(submissions.length, beforeImmediate + 1, "Stale partial menu must not swallow exact-leaf Enter");
  assert.equal(submissions.at(-1), "/ntn-skills ctl status");
  assert.deepEqual(lastReceipt().argv, [...cliCommand, "ctl", "status"]);
  assert.equal(currentAgentRequests.length, 0);

  scenario = "unknown-management-retains-draft";
  await draft("/ntn-skills settings");
  ownedEmpty();
  await key("\r");
  assert.match(lastReceipt().output, /HOST_COMMAND_UNEXPOSED/);
  assert.equal(editor.getText(), "/ntn-skills settings");
  assert.equal(restoredDrafts.at(-1), "/ntn-skills settings");
  assert.equal(currentAgentRequests.length, 0);
  assert.equal(nativeSettings.length, 0);

  async function delayedCandidate(cancellation: "escape" | "session" | "both") {
    await draft("/ntn-skills s");
    assert.equal(editor.isShowingAutocomplete(), true);
    let enter!: () => void, release!: () => void;
    let candidateEntered = false;
    const entered = new Promise<void>(resolve => { enter = () => { candidateEntered = true; resolve(); }; });
    const released = new Promise<void>(resolve => { release = resolve; });
    hold = { text: "/ntn-skills sy", entered, enter, released, release };
    type("y");
    await until(() => candidateEntered, "candidate delay boundary");
    state("candidate-pending-with-previous-menu");
    assert.equal(editor.isShowingAutocomplete(), true);
    if (cancellation !== "session") {
      editor.handleInput("\x1b");
      assert.equal(editor.isShowingAutocomplete(), false);
    }
    if (cancellation !== "escape") {
      const previous = sessionManager.getSessionId();
      await runner.emit({ type: "session_before_switch", targetSessionFile: "in-memory-next-session" });
      sessionManager.newSession();
      assert.notEqual(sessionManager.getSessionId(), previous);
      record("session-invalidated", { previous, current: sessionManager.getSessionId() });
      assert.equal(editor.isShowingAutocomplete(), false, "Session invalidation closes the old menu before the candidate resolves");
    }
    const before = submissions.length;
    hold.release();
    hold = undefined;
    await settle();
    assert.equal(editor.isShowingAutocomplete(), false, "Late cancelled candidate must never reopen the menu");
    assert.equal(editor.getText(), "/ntn-skills sy", "Late cancelled candidate must not apply");
    assert.equal(submissions.length, before);
    if (cancellation !== "escape") await runner.emit({ type: "session_switch", reason: "new" });
  }
  scenario = "late-candidate-after-escape";
  await delayedCandidate("escape");
  scenario = "late-candidate-after-session-invalidation";
  await delayedCandidate("session");
  scenario = "late-candidate-after-escape-and-session-invalidation";
  await delayedCandidate("both");

  scenario = "native-settings-still-active";
  await draft("/sett");
  const settings = latest();
  assert.equal(settings?.prefix, "/sett");
  assert.ok(settings?.items.some(item => item.value === "settings"));
  assert.equal(editor.isShowingAutocomplete(), true);
  const beforeNativeInput = inputResults.length;
  await key("\r");
  assert.equal(nativeSettings.length, 1);
  assert.equal(submissions.at(-1), "/settings");
  assert.equal(inputResults.length, beforeNativeInput, "Official native settings dispatch precedes extension input interception");
  assert.ok(completed.some(value => value.stage === "native" && value.text === "/sett" && value.result?.items.some(item => item.value === "settings")));

  scenario = "save-current-agent-once-with-images-and-conversation";
  sessionManager.appendMessage({ role: "user", content: "Current conversation after session switch", timestamp: 2 });
  const beforeSaveConversation = structuredClone(sessionManager.buildSessionContext().messages);
  const original = '/ntn-skills save 保存自然语言 😀 "quoted request"';
  const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "aW1hZ2UtZml4dHVyZQ==" }];
  await draft(original);
  ownedEmpty();
  nextImages = images;
  const beforeSaveSubmit = submissions.length;
  const beforeSaveRequests = currentAgentRequests.length;
  await key("\r");
  assert.equal(submissions.length, beforeSaveSubmit + 1);
  assert.equal(submissions.at(-1), original);
  const transformed = inputResults.at(-1)!.result;
  assert.ok(transformed.action === "transform");
  assert.equal(transformed.text.split(original).length - 1, 1, "Original save request is preserved exactly once");
  assert.ok(transformed.text.endsWith(original));
  assert.equal(transformed.text.split("Use the bundled ntn-skills-save Skill (workflow version").length - 1, 1);
  assert.ok(transformed.text.includes(JSON.stringify(cwd)));
  assert.ok(transformed.text.includes(JSON.stringify(cli)));
  assert.ok(transformed.text.includes(JSON.stringify(configPath)));
  assert.deepEqual(transformed.images, images);
  assert.equal(currentAgentRequests.length, beforeSaveRequests + 1);
  assert.deepEqual(currentAgentRequests.at(-1), { text: transformed.text, images });
  assert.equal(editor.disableSubmit, true, "Full factory's real preparation gate holds the current submission");
  // A repeated Enter while the receipt awaits the Agent must not create another
  // submission or expand the save workflow a second time.
  await key("\r");
  assert.equal(submissions.length, beforeSaveSubmit + 1);
  assert.equal(currentAgentRequests.length, beforeSaveRequests + 1);
  const beforeAgentStart = await runner.emitBeforeAgentStart(transformed.text, transformed.images, { cwd, forceSystemPrompt: "Consumer fixture system prompt" });
  record("before-agent-start", { result: beforeAgentStart });
  await runner.emit({ type: "agent_start" });
  assert.equal(editor.disableSubmit, false, "Matching current-Agent lifecycle releases submission gate");
  await runner.emit({ type: "agent_end", messages: [] });
  await settle();
  assert.equal(currentAgentRequests.length, 1, "Only save crosses the controlled current-Agent request boundary");
  assert.deepEqual(sessionManager.buildSessionContext().messages, beforeSaveConversation, "Save preparation never copies/replaces the active conversation");
  assert.deepEqual(userMessages, [], "Pi save must not call sendUserMessage");
  assert.equal(aborts, 0);
  assert.deepEqual(errors, []);
  const cliCalls: CliCall[] = (await readFile(callsPath, "utf8")).trim().split("\n").map(line => {
    const call: unknown = JSON.parse(line);
    assert.ok(call && typeof call === "object" && "argv" in call && Array.isArray(call.argv));
    assert.ok(call.argv.every((argument: unknown) => typeof argument === "string"));
    assert.ok("executable" in call && typeof call.executable === "string");
    assert.ok("cwd" in call && typeof call.cwd === "string");
    return { argv: call.argv, executable: call.executable, cwd: call.cwd };
  });
  assert.ok(cliCalls.some(call => call.argv[0] === "list"), "Full entry must discover the strict real source fixture");
  assert.ok(!notifications.some(notification => /SOURCE_RESPONSE_INVALID|source .*unavailable/.test(notification.text)), "Discovery fixture must pass the actual strict source contract");
  assert.deepEqual(cliCalls.filter(call => ["ctl", "read", "sync"].includes(call.argv[0])).map(call => call.argv), [
    ["ctl", "status"], ["read", spacedTarget], ["sync", "local", "run", spacedTarget], ["read", targetRef],
    ["ctl", "status", "--json", "--verbose"], ["ctl", "status"],
  ]);
  assert.ok(!cliCalls.some(call => ["settings", "save"].includes(call.argv[0]!)));
  const actualCwd = await realpath(cwd);
  assert.ok(cliCalls.every(call => call.cwd === actualCwd));
  await runner.emit({ type: "session_shutdown" });
  assert.deepEqual(errors, []);
  const summary = { ok: true, hostRoot, evidence, snapshotEntry: entry, driver: "Official InteractiveMode.setupEditorSubmitHandler; fixture normal-input consumer calls real ExtensionRunner.emitInput and records one current-Agent request without networking", providerFactories: providerFactories.length, submissions, nativeSettings: nativeSettings.length, currentAgentRequests, cliCalls, inputErrors: errors };
  await writeFile(join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (error) {
  record("failure", { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  console.error(`Official Pi command evidence: ${evidence}`);
  throw error;
} finally {
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
}
