import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions, EditorFactory, EditorLike, ExtensionContext } from "./types";
import { dollarAutocompletePrefixAtCursor, extractDollarAutocompletePrefix } from "./dollar";

const FACTORY_MARKER = Symbol.for("context-broker.dollar-editor-factory");
const EDITOR_MARKER = Symbol.for("context-broker.dollar-editor-instance");
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

type PiModule = {
  CustomEditor?: new (tui: unknown, theme: unknown, keybindings: unknown) => EditorLike;
};

type RequestOptions = { force: boolean; explicitTab: boolean };
type NativeList = {
  selectedIndex: number;
  filteredItems: AutocompleteItem[];
  getSelectedItem(): AutocompleteItem | null;
  setSelectedIndex(index: number): void;
  onSelect?: (item: AutocompleteItem) => void;
};
// Pi 1.6 has no public incremental-menu method. These runtime-checked hooks are
// deliberately confined to this adapter and replayed against its real Editor.
type NativeEditor = EditorLike & {
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  tui: { requestRender(): void };
  getText(): string;
  autocompleteProvider?: AutocompleteProvider;
  autocompleteList?: unknown;
  setAutocompleteProvider(provider: AutocompleteProvider): void;
  requestAutocomplete(options: RequestOptions): void;
  cancelAutocompleteRequest(): void;
  clearAutocompleteUi(): void;
  cancelAutocomplete(): void;
  applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void;
};
type Highlight = { kind: "initial" } | { kind: "none" } | { kind: "selected"; identity: string };
type InputSnapshot = { text: string; line: number; col: number; prefix: string };
type Intent = { phase: "waiting" | "open"; input: InputSnapshot; scope: unknown; highlight: Highlight; mode: "regular" | "force" };
type WrapperOptions = { keybindings?: unknown; warning?: (message: string) => void };
const retirement = new WeakMap<EditorLike, () => void>();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
function nativeEditor(editor: EditorLike): editor is NativeEditor {
  return ["getText", "setAutocompleteProvider", "requestAutocomplete", "cancelAutocompleteRequest", "clearAutocompleteUi", "cancelAutocomplete", "applyAutocompleteSuggestions"]
    .every(name => typeof Reflect.get(editor, name) === "function")
    && Array.isArray(editor.state?.lines) && editor.state.lines.every(line => typeof line === "string")
    && typeof editor.state.cursorLine === "number" && typeof editor.state.cursorCol === "number"
    && typeof editor.tui?.requestRender === "function";
}
function nativeList(value: unknown): value is NativeList {
  return object(value) && typeof value.selectedIndex === "number" && Array.isArray(value.filteredItems)
    && typeof value.getSelectedItem === "function" && typeof value.setSelectedIndex === "function"
    && (value.onSelect === undefined || typeof value.onSelect === "function");
}
function matchesKey(keybindings: unknown, data: string, action: string): boolean {
  if (object(keybindings) && typeof keybindings.matches === "function") return Boolean(keybindings.matches(data, action));
  return ({ "tui.select.cancel": ["\x1b", "\x03"], "tui.select.up": ["\x1b[A"], "tui.select.down": ["\x1b[B"],
    "tui.select.pageUp": ["\x1b[5~"], "tui.select.pageDown": ["\x1b[6~"], "tui.input.submit": ["\r"] }[action] ?? []).includes(data);
}

function installIncrementalMenu(editor: NativeEditor, options: WrapperOptions): void {
  const nativeRequest = editor.requestAutocomplete.bind(editor), nativeCancel = editor.cancelAutocomplete.bind(editor);
  const nativeCancelRequest = editor.cancelAutocompleteRequest.bind(editor), nativeSetProvider = editor.setAutocompleteProvider.bind(editor);
  const originalInput = editor.handleInput!.bind(editor);
  let intent: Intent | undefined, pending: AbortController | undefined, sequence = 0;
  let unsubscribe: (() => void) | undefined, warned = false;
  const keys = options.keybindings ?? Reflect.get(editor, "keybindings");
  const warning = () => {
    if (warned) return;
    warned = true;
    try { options.warning?.("Skill suggestions are unavailable. You can keep typing."); } catch { /* A notification cannot block the editor. */ }
  };
  const detach = () => { try { unsubscribe?.(); } catch { warning(); } finally { unsubscribe = undefined; } };
  const input = (): InputSnapshot | undefined => {
    const { lines, cursorLine: line, cursorCol: col } = editor.state;
    const prefix = dollarAutocompletePrefixAtCursor(lines, line, col);
    return prefix === undefined ? undefined : { text: editor.getText(), line, col, prefix };
  };
  const sameInput = (a: InputSnapshot, b = input()) => b !== undefined && a.text === b.text && a.line === b.line && a.col === b.col && a.prefix === b.prefix;
  const scope = () => editor.autocompleteProvider?.getCompletionScope?.();
  const stopRequest = () => { sequence++; pending?.abort(); pending = undefined; nativeCancelRequest(); };
  const dismiss = (clear = true) => {
    intent = undefined; stopRequest();
    if (clear) { editor.clearAutocompleteUi(); editor.tui.requestRender(); }
  };
  const valid = (current: Intent) => intent === current && sameInput(current.input) && current.scope === scope();
  const selectedHighlight = (current: Intent): Highlight => {
    if (current.phase !== "open") return current.highlight;
    const list = editor.autocompleteList;
    const selected = nativeList(list) ? list.getSelectedItem() : null;
    return selected?.identity ? { kind: "selected", identity: selected.identity } : { kind: "none" };
  };
  const publish = (current: Intent, suggestions: AutocompleteSuggestions | null, explicitTab: boolean) => {
    if (!valid(current)) { if (intent === current) dismiss(); return; }
    const highlight = selectedHighlight(current);
    const items = suggestions?.prefix === current.input.prefix && Array.isArray(suggestions.items)
      ? suggestions.items.filter(item => typeof item.value === "string" && item.value.length > 0) : [];
    if (!items.length) {
      current.phase = "waiting"; current.highlight = highlight.kind === "initial" ? highlight : { kind: "none" };
      editor.clearAutocompleteUi(); editor.tui.requestRender(); return;
    }
    editor.applyAutocompleteSuggestions({ items, prefix: current.input.prefix }, current.mode);
    const list = editor.autocompleteList;
    if (!nativeList(list)) { dismiss(); warning(); return; }
    current.phase = "open";
    if (highlight.kind !== "initial") {
      const index = highlight.kind === "selected" ? items.findIndex(item => item.identity === highlight.identity) : -1;
      // Pi's public setter clamps -1 to 0. Its real renderer/getSelectedItem
      // already support an empty selection; directional input below owns exit.
      if (index === -1) { list.selectedIndex = -1; current.highlight = { kind: "none" }; }
      else { list.setSelectedIndex(index); current.highlight = highlight; }
    }
    if (explicitTab && current.mode === "force" && items.length === 1) list.onSelect?.(items[0]!);
    editor.tui.requestRender();
  };
  const request = (current: Intent, explicitTab = false) => {
    stopRequest();
    const provider = editor.autocompleteProvider;
    if (!provider) return;
    const controller = new AbortController(), ticket = sequence;
    pending = controller;
    const cancelled = Promise.withResolvers<{ kind: "aborted" }>();
    const abort = () => cancelled.resolve({ kind: "aborted" });
    controller.signal.addEventListener("abort", abort, { once: true });
    const result = Promise.resolve().then(() => {
      if (controller.signal.aborted) return null;
      return provider.getSuggestions([...editor.state.lines], current.input.line, current.input.col, { signal: controller.signal, force: current.mode === "force" });
    }).then(value => ({ kind: "result" as const, value }), () => ({ kind: "error" as const }));
    // Each request has its own completion. A producer which ignores abort or
    // rejects never becomes a predecessor that later keystrokes must await.
    void Promise.race([result, cancelled.promise]).then(outcome => {
      if (controller.signal.aborted || ticket !== sequence || intent !== current) return;
      pending = undefined;
      if (!valid(current)) { dismiss(); return; }
      if (outcome.kind === "result") { warned = false; publish(current, outcome.value, explicitTab); }
      else if (outcome.kind === "error") { publish(current, null, false); warning(); }
    }).catch(() => { if (intent === current) { dismiss(); warning(); } })
      .finally(() => controller.signal.removeEventListener("abort", abort));
  };
  const attach = () => {
    detach();
    try {
      unsubscribe = editor.autocompleteProvider?.subscribe?.(() => {
        const current = intent;
        if (!current) return;
        try { if (valid(current)) request(current); else dismiss(); }
        catch { dismiss(); warning(); }
      });
    } catch { warning(); }
  };
  editor.setAutocompleteProvider = provider => { dismiss(); nativeSetProvider(provider); attach(); };
  editor.cancelAutocomplete = () => { dismiss(false); nativeCancel(); };
  editor.requestAutocomplete = requestOptions => {
    const captured = input();
    if (!captured) { dismiss(intent !== undefined); nativeRequest(requestOptions); return; }
    try {
      const current: Intent = { phase: "waiting", input: captured, scope: scope(), highlight: { kind: "initial" }, mode: requestOptions.force ? "force" : "regular" };
      intent = current; request(current, requestOptions.explicitTab);
    } catch { dismiss(); warning(); }
  };
  editor.handleInput = data => {
    const before = input(), beforeSequence = sequence;
    if (intent) {
      try { if (!valid(intent)) dismiss(); } catch { dismiss(); warning(); }
    }
    if (intent && matchesKey(keys, data, "tui.select.cancel")) { dismiss(); return; }
    const list = editor.autocompleteList;
    if (intent?.phase === "open" && nativeList(list) && list.selectedIndex < 0) {
      const up = matchesKey(keys, data, "tui.select.up") || matchesKey(keys, data, "tui.select.pageUp");
      const down = matchesKey(keys, data, "tui.select.down") || matchesKey(keys, data, "tui.select.pageDown");
      if (up || down) { list.setSelectedIndex(up ? list.filteredItems.length - 1 : 0); editor.tui.requestRender(); return; }
    }
    if (intent?.phase === "waiting" && matchesKey(keys, data, "tui.input.submit")) dismiss();
    originalInput(data);
    if (intent && !sameInput(intent.input)) dismiss();
    // Older/custom editors may not trigger '$' themselves. Never issue a
    // duplicate request when this input already went through the native hook.
    if (sequence === beforeSequence && shouldCheckAfterInput(data) && input()
      && (!before || !sameInput(before)) && !editor.isShowingAutocomplete?.()) editor.tryTriggerAutocomplete?.();
  };
  attach();
  retirement.set(editor, () => { dismiss(); detach(); });
}

function isMarkedFactory(factory: EditorFactory | undefined): boolean {
  return Boolean(factory && (factory as unknown as Record<symbol, unknown>)[FACTORY_MARKER]);
}

function markFactory(factory: EditorFactory): EditorFactory {
  (factory as unknown as Record<symbol, unknown>)[FACTORY_MARKER] = true;
  return factory;
}

function isMarkedEditor(editor: EditorLike): boolean {
  return Boolean(editor[EDITOR_MARKER]);
}

function markEditor(editor: EditorLike): void {
  editor[EDITOR_MARKER] = true;
}

export function isDollarAutocompleteContext(textBeforeCursor: string): boolean {
  return extractDollarAutocompletePrefix(textBeforeCursor) !== undefined;
}

function shouldCheckAfterInput(data: string): boolean {
  if (!data) return false;
  if (data === "\x1b" || data === "\x03") return false;
  if (data.includes("\x1b[200~")) return false;
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    return code >= 32 || data === "\x7f";
  }
  return data === "\x1b[3~";
}

function textBeforeCursor(editor: EditorLike): string | undefined {
  const state = editor.state;
  if (!state || !Array.isArray(state.lines)) return undefined;
  const cursorLine = typeof state.cursorLine === "number" ? state.cursorLine : 0;
  const cursorCol = typeof state.cursorCol === "number" ? state.cursorCol : 0;
  const line = state.lines[cursorLine] ?? "";
  return line.slice(0, cursorCol);
}

export function maybeTriggerDollarAutocomplete(editor: EditorLike, data: string): boolean {
  if (!shouldCheckAfterInput(data)) return false;
  if (editor.isShowingAutocomplete?.()) return false;
  const beforeCursor = textBeforeCursor(editor);
  if (beforeCursor === undefined || !isDollarAutocompleteContext(beforeCursor)) return false;
  editor.tryTriggerAutocomplete?.();
  return true;
}

export function wrapDollarAutocompleteEditor(editor: EditorLike, options: WrapperOptions = {}): EditorLike {
  if (isMarkedEditor(editor) || typeof editor.handleInput !== "function") return editor;
  if (nativeEditor(editor)) installIncrementalMenu(editor, options);
  else {
    const originalHandleInput = editor.handleInput.bind(editor);
    editor.handleInput = (data: string) => { originalHandleInput(data); maybeTriggerDollarAutocomplete(editor, data); };
  }
  markEditor(editor);
  return editor;
}

async function loadPiCustomEditor(): Promise<PiModule["CustomEditor"] | undefined> {
  try {
    const mod = await import(PI_PACKAGE_NAME) as PiModule;
    return mod.CustomEditor;
  } catch {
    return undefined;
  }
}

export async function installPiDollarAutocompleteEditor(ctx: ExtensionContext, bind: (editor: EditorLike) => EditorLike): Promise<boolean> {
  const ui = ctx.ui;
  if (!ui?.setEditorComponent || !ui.getEditorComponent) return false;
  const existingFactory = ui.getEditorComponent();
  if (isMarkedFactory(existingFactory)) return true;
  const CustomEditor = existingFactory ? undefined : await loadPiCustomEditor();
  if (!existingFactory && !CustomEditor) return false;
  let currentEditor: EditorLike | undefined;
  const factory = markFactory((tui: unknown, theme: unknown, keybindings: unknown) => {
    if (currentEditor) retirement.get(currentEditor)?.();
    const editor = existingFactory
      ? existingFactory(tui, theme, keybindings)
      : new CustomEditor!(tui, theme, keybindings);
    currentEditor = editor;
    return bind(wrapDollarAutocompleteEditor(editor, { keybindings, warning: message => ui.notify?.(message, "warning") }));
  });
  ui.setEditorComponent(factory);
  return true;
}
