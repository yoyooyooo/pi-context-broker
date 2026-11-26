import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "bun:test";
import type { AutocompleteItem, AutocompleteSuggestions } from "../src/types";
import { createDollarSkillAutocompleteProvider } from "../src/dollar";
import { notionCompletionCandidates, type CompletionCandidate } from "../src/completion-candidates";

const adapterPath = process.env.PI_DOLLAR_EDITOR_ADAPTER ?? fileURLToPath(new URL("../src/pi-dollar-editor.ts", import.meta.url));
const { wrapDollarAutocompleteEditor, observePiEditorStartup } = await import(pathToFileURL(adapterPath).href);

// This is a replay of the installed host's actual Editor and SelectList. The
// caller selects the maintained Pi package; no fake fifth provider argument.
const packageRoot = process.env.PI_DOLLAR_EDITOR_PACKAGE;
assert.ok(packageRoot, "Set PI_DOLLAR_EDITOR_PACKAGE to the installed Pi package root");
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
const requirePi = createRequire(join(packageRoot, "package.json"));
const tui = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const { CustomEditor } = await import(pathToFileURL(join(packageRoot, "dist/modes/interactive/components/custom-editor.js")).href);
const { KeybindingsManager } = await import(pathToFileURL(join(packageRoot, "dist/core/keybindings.js")).href);
const keybindings = new KeybindingsManager();
tui.setKeybindings(keybindings);
const plain = (text: string) => text;
const theme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
const item = (identity: string, name = identity): AutocompleteItem => ({ identity, value: "$" + name, label: "$" + name });
const tick = () => new Promise<void>(accept => setImmediate(accept));
async function settled() {
  // Also admits the unmodified host's 20 ms debounce when replaying a baseline.
  await new Promise(accept => setTimeout(accept, 30));
  for (let i = 0; i < 3; i++) await tick();
}

function fixture(Editor = CustomEditor, setup?: (editor: InstanceType<typeof CustomEditor>) => void, wrapperOptions = {}) {
  let items = [item("a"), item("b")], scope: unknown = {}, renders = 0;
  const listeners = new Set<() => void>(), accepted: AutocompleteItem[] = [], warnings: string[] = [], submitted: string[] = [];
  let produce = async (): Promise<AutocompleteSuggestions | null> => ({ items, prefix: "$" });
  const editor = new Editor({ requestRender() { renders++; }, terminal: { rows: 40, columns: 100 } }, theme, keybindings);
  wrapDollarAutocompleteEditor(editor, { ...wrapperOptions, keybindings, warning: (message: string) => warnings.push(message) });
  setup?.(editor);
  editor.onSubmit = (text: string) => submitted.push(text);
  editor.setAutocompleteProvider({
    triggerCharacters: ["$", "@"],
    getCompletionScope: () => scope,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    getSuggestions(lines: string[], line: number, col: number, options: unknown) {
      assert.equal(arguments.length, 4); assert.ok(options);
      return /[$@][^\s]*$/u.test(lines[line]!.slice(0, col)) ? produce() : Promise.resolve(null);
    },
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, selected: AutocompleteItem, prefix: string) {
      accepted.push(selected);
      const next = [...lines], before = next[cursorLine]!.slice(0, cursorCol - prefix.length), after = next[cursorLine]!.slice(cursorCol);
      next[cursorLine] = before + selected.value + " " + after;
      return { lines: next, cursorLine, cursorCol: before.length + selected.value.length + 1 };
    },
  });
  return {
    editor, accepted, warnings, submitted, listeners,
    setProducer(next: typeof produce) { produce = next; },
    change(next: AutocompleteItem[]) { items = next; for (const listener of listeners) listener(); },
    switchScope(notify = true) { scope = {}; if (notify) for (const listener of listeners) listener(); },
    frame() { return editor.render(100).join("\n"); },
    selected() { return editor.autocompleteList?.getSelectedItem() ?? null; },
    renders: () => renders,
  };
}

function startupFixture(Editor = CustomEditor) {
  let focused: unknown;
  const original = Editor.prototype.handleInput, observation = observePiEditorStartup(Editor);
  const screen = { requestRender() {}, getFocusedComponent: () => focused, terminal: { rows: 40, columns: 100 } };
  const editor = new Editor(screen, theme, keybindings); focused = editor;
  return { editor, screen, original, observation, focus(value: unknown) { focused = value; } };
}

test("native input before Broker installation hands off once without another dollar or implicit acceptance", async () => {
  const early = startupFixture();
  try {
    early.editor.handleInput("$"); early.editor.handleInput("\t");
    const startup = early.observation.take(early.screen); assert.ok(startup);
    assert.equal(CustomEditor.prototype.handleInput, early.original);
    const f = fixture(CustomEditor, editor => editor.setText(early.editor.getText()), { startup });
    await settled(); assert.match(f.frame(), /\$a/); assert.equal(f.editor.getText(), "$"); assert.equal(f.accepted.length, 0);
    f.change([item("later")]); await settled(); assert.match(f.frame(), /\$later/); assert.equal(f.accepted.length, 0);
    assert.equal(early.observation.take(early.screen), undefined);
  } finally { early.observation.dispose(); }
});

test("early Escape, unknown history, changed draft, cursor, scope and focus never become copied-draft intent", async () => {
  for (const action of ["escape", "history", "draft", "cursor", "scope", "focus", "stopped"] as const) {
    const early = startupFixture(); let escaped = 0, owner: unknown = {};
    try {
      early.editor.onEscape = () => { escaped++; };
      if (action === "scope") early.editor.setAutocompleteProvider({ getCompletionScope: () => owner, async getSuggestions() { return null; } });
      if (action === "history") early.editor.setText("$"); else early.editor.handleInput("$");
      if (action === "escape") { early.editor.handleInput("\x1b"); assert.equal(escaped, 1); }
      if (action === "draft") early.editor.setText("changed $");
      if (action === "cursor") early.editor.handleInput("\x1b[D");
      if (action === "scope") owner = {};
      if (action === "focus") { const other = new CustomEditor(early.screen, theme, keybindings); other.setText("$"); early.focus(other); }
      if (action === "stopped") early.observation.dispose();
      const startup = early.observation.take(early.screen); assert.equal(startup, undefined, action);
      const f = fixture(CustomEditor, editor => editor.setText(early.editor.getText()), { startup });
      f.change([item("late")]); await settled(); assert.equal(f.editor.isShowingAutocomplete(), false, action);
    } finally { early.observation.dispose(); }
  }
});

test("startup observation belongs to the focused instance and preserves native returns and exceptions", () => {
  const returned = {}, failure = new Error("native failure"); let calls = 0;
  class Native extends CustomEditor {
    handleInput(data: string) { calls++; if (data === "!") throw failure; super.handleInput(data); return returned; }
  }
  const early = startupFixture(Native);
  try {
    assert.equal(early.editor.handleInput("$"), returned); assert.equal(calls, 1);
    const other = new Native(early.screen, theme, keybindings); early.focus(other);
    assert.equal(other.handleInput("$b"), returned); assert.equal(calls, 2);
    early.focus(early.editor);
    assert.equal(early.observation.take(early.screen)?.input.text, "$");
    assert.equal(Native.prototype.handleInput, early.original);
    assert.throws(() => other.handleInput("!"), error => error === failure); assert.equal(calls, 3);
  } finally { early.observation.dispose(); }
  const throwing = startupFixture(Native);
  try {
    throwing.editor.handleInput("$");
    assert.throws(() => throwing.editor.handleInput("!"), error => error === failure);
    assert.equal(throwing.observation.take(throwing.screen), undefined);
  } finally { throwing.observation.dispose(); }
});

test("losing the native input method cannot revive an unobserved Escape or overwrite another extension", () => {
  for (const change of ["prototype", "instance", "descriptor"] as const) {
    class Native extends CustomEditor { handleInput(data: string) { super.handleInput(data); } }
    const original = Object.getOwnPropertyDescriptor(Native.prototype, "handleInput")!;
    const early = startupFixture(Native);
    const replacement = function(this: InstanceType<typeof CustomEditor>, data: string) { return early.original.call(this, data); };
    try {
      early.editor.handleInput("$");
      if (change === "prototype") Native.prototype.handleInput = replacement;
      else if (change === "instance") early.editor.handleInput = replacement;
      else Object.defineProperty(Native.prototype, "handleInput", { enumerable: !original.enumerable });
      early.editor.handleInput("\x1b"); assert.equal(early.editor.getText(), "$");
      assert.equal(early.observation.take(early.screen), undefined);
      if (change === "prototype") assert.equal(Native.prototype.handleInput, replacement);
      else if (change === "instance") assert.equal(early.editor.handleInput, replacement);
      else assert.equal(Object.getOwnPropertyDescriptor(Native.prototype, "handleInput")?.enumerable, !original.enumerable);
    } finally { early.observation.dispose(); Object.defineProperty(Native.prototype, "handleInput", original); }
  }
});

test("installed Pi " + manifest.version + " updates cached candidates without another key", async () => {
  const f = fixture();
  f.editor.handleInput("$"); await settled();
  assert.match(f.frame(), /\$a/);
  const text = f.editor.getText(), cursor = { ...f.editor.state }, previousRenders = f.renders();
  f.change([item("a"), item("c")]); await settled();
  assert.match(f.frame(), /\$c/);
  assert.equal(f.editor.getText(), text); assert.deepEqual(f.editor.state, cursor);
  assert.ok(f.renders() > previousRenders);
});

test("waiting empty is not dismissal and a single background result is not accepted", async () => {
  const f = fixture(); f.change([]); f.editor.handleInput("$"); await settled();
  assert.equal(f.editor.isShowingAutocomplete(), false);
  f.change([item("a")]); await settled();
  assert.match(f.frame(), /\$a/); assert.equal(f.editor.getText(), "$"); assert.equal(f.accepted.length, 0);
});

test("Escape cancels both waiting and open intents including uncooperative late results", async () => {
  for (const waiting of [true, false]) {
    const f = fixture(), pending = Promise.withResolvers<AutocompleteSuggestions>();
    if (waiting) f.setProducer(() => pending.promise);
    f.editor.handleInput("$"); await settled(); f.editor.handleInput("\x1b");
    pending.resolve({ items: [item("late")], prefix: "$" });
    f.change([item("later")]); await settled();
    assert.equal(f.editor.isShowingAutocomplete(), false); assert.equal(f.editor.getText(), "$");
  }
});

test("highlight follows stable identity through reorder, same-name arrival and rename", async () => {
  const f = fixture(); f.editor.handleInput("$"); await settled(); f.editor.handleInput("\x1b[B");
  assert.equal(f.selected().identity, "b");
  const selected = item("b", "renamed");
  f.change([item("other", "b"), selected, item("a")]); await settled();
  assert.equal(f.selected(), selected);
  f.editor.handleInput("\t");
  assert.equal(f.accepted[0], selected); assert.equal(f.editor.getText(), "$renamed ");
});

test("native startup provider rebinding preserves an open intent and highlighted identity", async () => {
  const f = fixture(); f.editor.handleInput("$"); await settled(); f.editor.handleInput("\x1b[B");
  assert.equal(f.selected().identity, "b");
  // InteractiveMode rebuilds its provider after the session_start handlers finish.
  f.editor.setAutocompleteProvider({ ...f.editor.autocompleteProvider });
  const selected = item("b", "renamed"); f.change([selected, item("a")]); await settled();
  assert.equal(f.selected(), selected); assert.equal(f.editor.getText(), "$"); assert.equal(f.accepted.length, 0);
  f.editor.handleInput("\t"); assert.equal(f.accepted[0], selected); assert.equal(f.editor.getText(), "$renamed ");
});

test("native provider rebinding preserves waiting without turning a later result into Tab acceptance", async () => {
  const f = fixture(); f.change([]); f.editor.handleInput("$"); await settled();
  f.editor.handleInput("\t"); await settled();
  f.editor.setAutocompleteProvider({ ...f.editor.autocompleteProvider });
  f.change([item("late")]); await settled();
  assert.match(f.frame(), /\$late/); assert.equal(f.editor.getText(), "$"); assert.equal(f.accepted.length, 0);
});

test("provider rebinding cannot reopen Escape dismissal or carry an intent into another scope or draft", async () => {
  for (const close of ["escape", "scope", "draft"] as const) {
    const f = fixture(); f.editor.handleInput("$"); await settled();
    if (close === "escape") f.editor.handleInput("\x1b");
    else if (close === "scope") f.switchScope(false);
    else f.editor.setText("changed $");
    f.editor.setAutocompleteProvider({ ...f.editor.autocompleteProvider }); f.change([item("later")]); await settled();
    assert.equal(f.editor.isShowingAutocomplete(), false); assert.equal(f.editor.getText(), close === "draft" ? "changed $" : "$"); assert.equal(f.accepted.length, 0);
  }
});

test("withdrawn highlight stays unselected until a new direction key", async () => {
  const f = fixture(); f.editor.handleInput("$"); await settled(); f.editor.handleInput("\x1b[B");
  f.change([item("a"), item("c")]); await settled();
  assert.equal(f.selected(), null); assert.doesNotMatch(f.frame(), /→/);
  f.editor.setAutocompleteProvider({ ...f.editor.autocompleteProvider }); await settled();
  assert.equal(f.selected(), null); assert.doesNotMatch(f.frame(), /→/);
  f.editor.handleInput("\t"); assert.equal(f.accepted.length, 0);
  f.change([item("c"), item("a")]); await settled(); assert.equal(f.selected(), null);
  f.editor.handleInput("\x1b[A"); assert.equal(f.selected().identity, "a");
  f.editor.handleInput("\t"); assert.equal(f.accepted[0]!.identity, "a");
});

test("Enter remains usable after withdrawal and while a producer never settles", async () => {
  for (const pending of [true, false]) {
    const f = fixture(); if (pending) f.setProducer(() => new Promise(() => {}));
    f.editor.handleInput("$"); await settled();
    if (!pending) { f.change([item("different")]); await settled(); }
    f.editor.handleInput("\r"); await settled();
    assert.deepEqual(f.submitted, ["$"]); assert.equal(f.accepted.length, 0);
  }
});

test("a rejected or never-settling old request cannot hold the next input", async () => {
  for (const reject of [true, false]) {
    const f = fixture(), pending = Promise.withResolvers<AutocompleteSuggestions>();
    f.setProducer(() => pending.promise); f.editor.handleInput("$"); await settled();
    f.setProducer(async () => ({ items: [item("new")], prefix: "$n" }));
    f.editor.handleInput("n"); if (reject) pending.reject(new Error("old failure")); await settled();
    assert.match(f.frame(), /\$new/); assert.equal(f.editor.getText(), "$n");
  }
});

test("current rejection is warning-only and later snapshot can recover", async () => {
  const f = fixture(); f.setProducer(async () => { throw new Error("offline"); });
  f.editor.handleInput("$"); await settled();
  assert.equal(f.warnings.length, 1); assert.equal(f.editor.isShowingAutocomplete(), false);
  f.change([]); await settled(); assert.equal(f.warnings.length, 1, "one warning for the continuing failure");
  f.setProducer(async () => ({ items: [item("recovered")], prefix: "$" }));
  f.change([item("recovered")]); await settled(); assert.match(f.frame(), /\$recovered/);
});

test("cursor motion, deleting dollar, scope change and acceptance revoke late display rights", async () => {
  for (const action of ["cursor", "delete", "scope", "accept"]) {
    const f = fixture(); f.editor.handleInput("$"); await settled();
    const pending = Promise.withResolvers<AutocompleteSuggestions>();
    f.setProducer(() => pending.promise); f.change([item("new")]); await tick();
    if (action === "cursor") f.editor.handleInput("\x1b[D");
    if (action === "delete") f.editor.handleInput("\x7f");
    if (action === "scope") f.switchScope();
    if (action === "accept") f.editor.handleInput("\t");
    pending.resolve({ items: [item("late")], prefix: "$" }); await settled();
    assert.equal(f.editor.isShowingAutocomplete(), false, action);
    if (action === "accept") assert.equal(f.accepted[0]!.identity, "a");
  }
});

test("native Editor, undo and another trigger retain host behavior", async () => {
  const f = fixture(tui.Editor); f.editor.handleInput("$"); await settled();
  f.editor.handleInput("\t"); assert.equal(f.editor.getText(), "$a ");
  f.editor.handleInput("\x1f"); assert.equal(f.editor.getText(), "$");
  f.editor.setText(""); f.setProducer(async () => ({ items: [{ value: "@file", label: "@file" }], prefix: "@" }));
  f.editor.handleInput("@"); await new Promise(accept => setTimeout(accept, 130)); await settled();
  assert.match(f.frame(), /@file/);
});

test("real Broker provider accepts the displayed Notion candidate object after a silent replacement", async () => {
  const f = fixture(), accepted: CompletionCandidate[] = [], listeners = new Set<() => void>(), owner = {};
  const library = "00000000-0000-4000-8000-000000000001";
  const record = { id: "logical-a", kind: "skill" as const, name: "A", alias: "same", description: "Original",
    default_context: false, enabled: true, entrypoint: "SKILL.md", ref: "skill://logical-a?library=" + library,
    locator: { type: "shared_skill" as const, page_id: "00000000-0000-4000-8000-000000000002", database_id: "db", data_source_id: "ds", library_id: library, skill_id: "logical-a" } };
  const source = { id: "source-a", type: "notion" as const, namespace: "daily", library };
  const original = notionCompletionCandidates([record], source, "scope-a", true)[0]!;
  let candidates = [original];
  const provider = createDollarSkillAutocompleteProvider({
    async getSuggestions() { return null; }, applyCompletion(lines, cursorLine, cursorCol) { return { lines, cursorLine, cursorCol }; },
  }, {
    read: () => ({ candidates, revision: 1 }), scope: () => owner,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  }, value => accepted.push(value));
  f.editor.setAutocompleteProvider(provider); f.editor.handleInput("$"); await settled();
  const displayed = f.selected(); assert.equal(displayed.candidate, original);
  candidates = notionCompletionCandidates([{ ...record, id: "logical-b", locator: { ...record.locator, skill_id: "logical-b", page_id: "00000000-0000-4000-8000-000000000003" } }], source, "scope-a", true);
  // Model the refresh/accept race: data changed, but its notification/render has
  // not happened yet. Tab must consume the actual item the user still sees.
  f.editor.handleInput("\t");
  assert.equal(accepted[0], original); assert.equal(accepted[0]!.record.id, "logical-a");
  assert.equal(f.editor.getText(), "$same@daily ");
  for (const listener of listeners) listener(); await settled(); assert.equal(accepted.length, 1);
});
