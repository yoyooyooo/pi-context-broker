import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
// @ts-ignore Resolved by the actual OMP extension loader, never a stand-in editor.
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components";
// @ts-ignore Resolved by the installed OMP loader alongside CustomEditor.
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui";
import { installOmpDollarAutocompleteEditor } from "../src/omp-dollar-editor";
import { createDollarSkillAutocompleteProvider, dollarAutocompletePrefixAtCursor } from "../src/dollar";
import type { AutocompleteProvider, EditorFactory, DiscoveryRecord } from "../src/types";
type RuntimeEditor = {
  getText(): string; getExpandedText(): string; getLines(): string[];
  getCursor(): { line: number; col: number }; textRevision: number; atoms: ReadonlyMap<string, string>;
  handleInput(data: string): void; handleNativeEvent(event: { type: string; from?: number; to?: number; text?: string; cursor?: number; len?: number }): void;
  isShowingAutocomplete(): boolean; setAutocompleteProvider(provider: AutocompleteProvider): void; setText(text: string): void;
  setVimMode(enabled: boolean): void;
  describe(context: { cols: number; supports(kind: string): boolean }): unknown;
  render(width: number): string[];
  vimMode: string;
};

// Run as an explicit extension of the installed OMP binary with isolated HOME/config.
export default async function (): Promise<void> {
  const output = process.env.OMP_CURSOR_TEST_OUTPUT;
  assert.ok(output, "Set OMP_CURSOR_TEST_OUTPUT for the retained actual-host receipt");
  const frames: unknown[] = [];
  try {
    const saved: unknown = JSON.parse(readFileSync(process.env.OMP_CURSOR_TEST_METADATA!, "utf8"));
    assert.ok(saved && typeof saved === "object" && "records" in saved && Array.isArray(saved.records));
    const records: DiscoveryRecord[] = [];
    for (const item of saved.records) {
      if (!item || typeof item !== "object" || !["scoped-prompt", "scoped-router", "scoped-evidence"].includes(item.alias)) continue;
      assert.equal(typeof item.alias, "string"); assert.equal(typeof item.ref, "string");
      assert.ok(["prompt", "router", "skill"].includes(item.kind));
      records.push({ name: item.alias, normalizedName: item.alias, description: "retained control metadata", normalizedDescription: "retained control metadata", aliases: [], normalizedAliases: [], path: item.ref, ref: item.ref, kind: item.kind, source: "notion", sourceId: "ah258-content", token: `ah258-content/${item.alias}`, selectionToken: `${item.alias}@ah258-content` });
    }
    assert.equal(records.length, 3);
    let factory: EditorFactory | undefined;
    await installOmpDollarAutocompleteEditor({ hasUI: true, ui: { setEditorComponent(value) { factory = value; } } }, editor => editor);
    assert.ok(factory);
    let wrapped: AutocompleteProvider;
    const original = CustomEditor.prototype.setAutocompleteProvider;
    CustomEditor.prototype.setAutocompleteProvider = function (provider: AutocompleteProvider) { wrapped = provider; original.call(this, provider); };
    const paint = (text: string) => text;
    // The factory is the real host subclass; this local shape documents exercised public APIs.
    const editor = factory({ requestRender() {} }, { borderColor: paint, selectList: { selectedPrefix: paint, selectedText: paint, description: paint, scrollInfo: paint, noMatch: paint } }, undefined) as unknown as RuntimeEditor;
    CustomEditor.prototype.setAutocompleteProvider = original;
    let inlineCalls = 0;
    const native = new CombinedAutocompleteProvider([{ name: "hint", description: "Native hint regression", getInlineHint: () => { inlineCalls++; return "native receiver hint"; } }], process.cwd());
    const context = { cols: 100, supports: () => true };
    editor.setAutocompleteProvider(native);
    for (const key of ["a", "b", "中", "文", "\x1b[D", "\x1b[C", "\x7f"]) {
      editor.handleInput(key);
      editor.describe(context);
      frames.push({ label: "ordinary-key-described", key, text: editor.getText(), cursor: editor.getCursor() });
    }
    editor.setText("/hint argument");
    assert.equal(native.getInlineHint(editor.getLines(), 0, editor.getCursor().col), "native receiver hint");
    editor.describe(context);
    assert.ok(inlineCalls > 1, "describe reaches the actual native inline provider with its branded receiver");
    frames.push({ label: "native-inline-hint-described", inlineCalls, text: editor.getText() });
    editor.setText("");
    let queries = 0, delegated = 0, metadataLoads = 0;
    let release: (() => void) | undefined;
    let delayed = false;
    const signals: AbortSignal[] = [];
    const base: AutocompleteProvider = {
      async getSuggestions() { return { prefix: "/na", items: [{ value: "native", label: "native" }] }; },
      applyCompletion(lines, line, col, item, prefix) {
        delegated++;
        const next = [...lines];
        next[line] = lines[line]!.slice(0, col - prefix.length) + item.value + " " + lines[line]!.slice(col);
        return { lines: next, cursorLine: line, cursorCol: col - prefix.length + item.value.length + 1 };
      },
    };
    const metadata = Promise.resolve(records).then(value => { metadataLoads++; return value; });
    const broker = createDollarSkillAutocompleteProvider(base, metadata);
    const provider = Object.create(broker) as AutocompleteProvider;
    provider.getSuggestions = async (...args) => {
      queries++;
      const options = args[3];
      const signal = options && ("signal" in options ? options.signal : options);
      if (signal) signals.push(signal);
      if (delayed) {
        const gate = Promise.withResolvers<void>();
        release = gate.resolve;
        await gate.promise;
      }
      return broker.getSuggestions(...args);
    };
    const capture = CustomEditor.prototype.setAutocompleteProvider;
    CustomEditor.prototype.setAutocompleteProvider = function (provider: AutocompleteProvider) { wrapped = provider; capture.call(this, provider); };
    editor.setAutocompleteProvider(provider);
    CustomEditor.prototype.setAutocompleteProvider = capture;
    const flush = async () => { for (let index = 0; index < 64; index++) await Promise.resolve(); };
    const frame = (label: string) => { editor.describe(context); frames.push({ label, text: editor.getText(), cursor: editor.getCursor(), revision: editor.textRevision, visible: editor.isShowingAutocomplete(), queries }); };
    const move = (cursor: number, len = editor.getText().length) => editor.handleNativeEvent({ type: "edit", from: cursor, to: cursor, text: "", cursor, len });
    const draft = "前文😀 $scoped-p 尾文";
    editor.handleInput(draft);
    await flush();
    const revision = editor.textRevision;
    frame("typed-original-control-text");
    for (let index = 0; index < 3; index++) { editor.handleInput("\x1b[D"); frame(`left-${index + 1}`); }
    await flush();
    assert.equal(editor.textRevision, revision);
    assert.equal(editor.getCursor().col, draft.indexOf(" 尾文"));
    assert.equal(editor.getText(), draft);
    assert.equal(editor.isShowingAutocomplete(), true);
    frame("cursor-only-candidate");
    const selected = await wrapped!.getSuggestions(editor.getLines(), 0, editor.getCursor().col);
    const prompt = selected!.items.find(item => item.kind === "prompt")!;
    assert.ok(prompt.value.includes("scoped-prompt"));
    assert.ok(prompt.ref);
    editor.handleInput("\t");
    await flush();
    assert.equal(editor.getExpandedText(), `前文😀 ${prompt.value} 尾文`);
    assert.equal(editor.atoms.size, 1);
    frame("accepted-prompt-atom");
    const atom = [...editor.atoms.keys()][0] as string;
    const atomStart = editor.getText().indexOf(atom);
    for (const cursor of [atomStart + 1, atomStart + Math.floor(atom.length / 2), atomStart + atom.length]) {
      move(cursor); await flush(); assert.equal(editor.isShowingAutocomplete(), false);
    }
    move(atomStart + atom.length);
    editor.handleInput("\x7f");
    assert.ok(!editor.getText().includes(atom));
    editor.handleNativeEvent({ type: "undo" });
    assert.ok(editor.getText().includes(atom));
    frame("whole-atom-delete-undo");

    editor.setText(draft);
    move(draft.indexOf(" 尾文")); await flush();
    const nativeRevision = editor.textRevision;
    assert.equal(editor.isShowingAutocomplete(), true);
    frame("native-caret-only-candidate");
    move(0); await flush();
    assert.equal(editor.textRevision, nativeRevision);
    assert.equal(editor.isShowingAutocomplete(), false);
    const afterAway = queries;
    move(1); move(2); move(4); await flush();
    assert.equal(queries, afterAway, "non-prefix arrows/caret moves do not query metadata");
    move(draft.indexOf(" 尾文"), draft.length + 1); await flush();
    assert.equal(editor.getCursor().col, 4, "stale native edit was ignored");

    move(draft.indexOf(" 尾文")); await flush();
    const owned = await wrapped!.getSuggestions(editor.getLines(), 0, editor.getCursor().col);
    move(0); move(draft.indexOf(" 尾文")); await flush();
    const stale = wrapped!.applyCompletion(editor.getLines(), 0, editor.getCursor().col, owned!.items[0]!, owned!.prefix);
    assert.equal(stale.lines[0], draft, "returning to the same cursor does not revive a prior generation");
    const beforeForeign = delegated;
    const foreign = wrapped!.applyCompletion(["/na"], 0, 3, { value: "native", label: "native" }, "/na");
    assert.equal(foreign.lines[0], "native ");
    assert.equal(delegated, beforeForeign + 1);
    assert.equal(foreign.onApplied, undefined, "foreign completion is never broker-collapsed");

    editor.handleInput("\x1b"); move(0);
    delayed = true;
    move(draft.indexOf(" 尾文")); await flush();
    assert.ok(release);
    const pendingSignal = signals.at(-1)!;
    move(0);
    assert.equal(pendingSignal.aborted, true);
    delayed = false; release!(); await flush();
    assert.equal(editor.isShowingAutocomplete(), false);
    assert.equal(editor.getText(), draft);
    frame("late-result-ignored");
    assert.equal(await broker.getSuggestions(["$😀"], 0, 2), null);
    assert.equal(dollarAutocompletePrefixAtCursor(["$😀"], 0, 2), undefined);
    assert.equal(metadataLoads, 1);
    assert.equal((await broker.getSuggestions(["/na"], 0, 3))?.prefix, "/na");
    move(draft.indexOf(" 尾文")); await flush();
    editor.setVimMode(true);
    editor.handleInput("\x1b");
    editor.handleInput("\x1b");
    editor.handleInput("v"); await flush();
    assert.equal(editor.vimMode, "visual");
    assert.equal(editor.getText(), draft);
    assert.equal(editor.isShowingAutocomplete(), false, "visual selection does not open dollar completion");
    frame("visual-selection-hidden");
    writeFileSync(output, JSON.stringify({ ok: true, runtime: process.version, executable: process.execPath, metadataLoads, queries, frames }, null, 2) + "\n");
  } catch (error) {
    writeFileSync(output, JSON.stringify({ ok: false, error: String(error), stack: (error as Error).stack, frames }, null, 2) + "\n");
    throw error;
  }
}
