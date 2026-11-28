import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions, EditorFactory, EditorLike, ExtensionAPI, ExtensionContext } from "./types";
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
type StartupIntent = Omit<Intent, "phase">;
type WrapperOptions = { keybindings?: unknown; warning?: (message: string) => void; startup?: StartupIntent };
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

function editorInput(editor: NativeEditor): InputSnapshot | undefined {
  const { lines, cursorLine: line, cursorCol: col } = editor.state;
  const prefix = dollarAutocompletePrefixAtCursor(lines, line, col);
  return prefix === undefined ? undefined : { text: editor.getText(), line, col, prefix };
}
function sameInput(a: InputSnapshot, b: InputSnapshot | undefined): boolean {
  return b !== undefined && a.text === b.text && a.line === b.line && a.col === b.col && a.prefix === b.prefix;
}
function focusedEditor(tui: unknown): NativeEditor | undefined {
  if (!object(tui) || typeof tui.getFocusedComponent !== "function") return undefined;
  const focused: unknown = tui.getFocusedComponent();
  return object(focused) && nativeEditor(focused as EditorLike) && focused.tui === tui ? focused as NativeEditor : undefined;
}

// Pi starts its native editor before running extension session_start handlers.
// Observe only actual input during that short interval; a copied '$' draft alone
// cannot tell us whether its owner already pressed Escape. The factory consumes
// this record only for the same focused native instance and exact cursor/draft.
export function observePiEditorStartup(Editor: NonNullable<PiModule["CustomEditor"]>) {
  type ObservedIntent = StartupIntent & { inputMethod: EditorLike["handleInput"] };
  let active = true, snapshots = new WeakMap<NativeEditor, ObservedIntent>();
  const prototype = Editor.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "handleInput");
  const ownsMethod = () => {
    const current = Object.getOwnPropertyDescriptor(prototype, "handleInput");
    return current?.value === observed && (["writable", "enumerable", "configurable"] as const)
      .every(flag => current[flag] === descriptor?.[flag]);
  };
  const dispose = () => {
    active = false; snapshots = new WeakMap();
    try {
      // A later extension may have replaced/wrapped this method. Leave its
      // change in place; our captured wrapper is then an inert passthrough.
      if (descriptor && ownsMethod()) {
        Object.defineProperty(prototype, "handleInput", descriptor);
      }
    } catch { /* Observation cannot prevent native input or shutdown. */ }
  };
  const afterInput = (editor: NativeEditor, data: string, before: InputSnapshot | undefined, inputMethod: EditorLike["handleInput"]) => {
    if (focusedEditor(editor.tui) !== editor || editor.handleInput !== inputMethod) { snapshots.delete(editor); return; }
    const keys = Reflect.get(editor, "keybindings"), after = editorInput(editor);
    if (matchesKey(keys, data, "tui.select.cancel") || matchesKey(keys, data, "app.interrupt")
      || matchesKey(keys, data, "tui.input.submit")) { snapshots.delete(editor); return; }
    const force = matchesKey(keys, data, "tui.input.tab");
    const typed = shouldCheckAfterInput(data) || data.length > 1 && !/[\x00-\x1f\x7f]/u.test(data);
    if (after && (force || typed && (!before || !sameInput(before, after)))) {
      snapshots.set(editor, { input: after, inputMethod, scope: editor.autocompleteProvider?.getCompletionScope?.(),
        highlight: { kind: "initial" }, mode: force ? "force" : "regular" });
    } else {
      const current = snapshots.get(editor);
      if (current && !sameInput(current.input, after)) snapshots.delete(editor);
    }
    const current = snapshots.get(editor), list = editor.autocompleteList;
    if (current && nativeList(list)) {
      const selected = list.getSelectedItem();
      current.highlight = selected?.identity ? { kind: "selected", identity: selected.identity } : { kind: "none" };
    }
  };
  function observed(this: EditorLike, data: string) {
    let editor: NativeEditor | undefined, before: InputSnapshot | undefined, inputMethod: EditorLike["handleInput"], completed = false;
    try { if (active && nativeEditor(this) && focusedEditor(this.tui) === this) { editor = this; before = editorInput(this); inputMethod = this.handleInput; } }
    catch { /* An unsupported host remains entirely native. */ }
    try {
      const result: unknown = Reflect.apply(descriptor!.value, this, [data]);
      completed = true; return result;
    } finally {
      if (active && editor) {
        try { if (completed) afterInput(editor, data, before, inputMethod); else snapshots.delete(editor); }
        catch { snapshots.delete(editor); }
      }
    }
  }
  try {
    if (!descriptor || typeof descriptor.value !== "function"
      || !["getText", "setAutocompleteProvider", "requestAutocomplete", "cancelAutocomplete", "applyAutocompleteSuggestions"]
        .every(name => typeof Reflect.get(prototype, name) === "function")) active = false;
    else Object.defineProperty(prototype, "handleInput", { ...descriptor, value: observed });
  } catch { active = false; }
  return {
    take(tui: unknown): StartupIntent | undefined {
      try {
        if (!ownsMethod()) return undefined;
        const editor = active ? focusedEditor(tui) : undefined, current = editor && snapshots.get(editor);
        if (!editor || !current || current.inputMethod !== editor.handleInput || !sameInput(current.input, editorInput(editor))) return undefined;
        const scope = editor.autocompleteProvider?.getCompletionScope?.();
        if (current.scope !== undefined && current.scope !== scope) return undefined;
        return { input: current.input, highlight: current.highlight, mode: current.mode, scope };
      } catch { return undefined; }
      finally { dispose(); }
    },
    dispose,
  };
}

let editorModule: Promise<PiModule["CustomEditor"] | undefined> | undefined;
let startupObservation: ReturnType<typeof observePiEditorStartup> | undefined;
export async function preparePiDollarAutocompleteEditor(api: Pick<ExtensionAPI, "on">): Promise<void> {
  try {
    const Editor = await (editorModule ??= loadPiCustomEditor());
    startupObservation?.dispose();
    if (!Editor) return;
    const observation = startupObservation = observePiEditorStartup(Editor);
    api.on("session_shutdown", () => observation.dispose());
    api.on("session_start", (_event, ctx) => { if (!ctx.hasUI) observation.dispose(); });
  } catch { startupObservation?.dispose(); }
}

function installIncrementalMenu(editor: NativeEditor, options: WrapperOptions): void {
  const nativeRequest = editor.requestAutocomplete.bind(editor), nativeCancel = editor.cancelAutocomplete.bind(editor);
  const nativeCancelRequest = editor.cancelAutocompleteRequest.bind(editor), nativeSetProvider = editor.setAutocompleteProvider.bind(editor);
  const originalInput = editor.handleInput!.bind(editor);
  let intent: Intent | undefined, pending: AbortController | undefined, sequence = 0;
  let startup = options.startup;
  let unsubscribe: (() => void) | undefined, warned = false;
  const keys = options.keybindings ?? Reflect.get(editor, "keybindings");
  const warning = () => {
    if (warned) return;
    warned = true;
    try { options.warning?.("Skill suggestions are unavailable. You can keep typing."); } catch { /* A notification cannot block the editor. */ }
  };
  const detach = () => { try { unsubscribe?.(); } catch { warning(); } finally { unsubscribe = undefined; } };
  const input = () => editorInput(editor);
  const matchesInput = (a: InputSnapshot) => sameInput(a, input());
  const scope = () => editor.autocompleteProvider?.getCompletionScope?.();
  const stopRequest = () => { sequence++; pending?.abort(); pending = undefined; nativeCancelRequest(); };
  const dismiss = (clear = true) => {
    intent = undefined; stopRequest();
    if (clear) { editor.clearAutocompleteUi(); editor.tui.requestRender(); }
  };
  const valid = (current: Intent) => intent === current && matchesInput(current.input) && current.scope === scope();
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
  editor.setAutocompleteProvider = provider => {
    const initial = startup; startup = undefined;
    let retained: { current: Intent; highlight: Highlight } | undefined;
    try {
      const current = intent;
      if (current && valid(current) && current.scope !== undefined && current.scope === provider.getCompletionScope?.()) {
        retained = { current, highlight: selectedHighlight(current) };
      }
    } catch { warning(); }
    // Pi rebuilds its provider after session_start while the editor already
    // accepts input. Its native setter cancels the old menu; that is not an Esc.
    dismiss();
    nativeSetProvider(provider);
    attach();
    if (!retained && initial) {
      try {
        const owner = scope();
        if (owner !== undefined && (initial.scope === undefined || initial.scope === owner) && matchesInput(initial.input)) {
          retained = { current: { ...initial, scope: owner, phase: "waiting" }, highlight: initial.highlight };
        }
      } catch { warning(); }
    }
    if (retained) {
      const { current, highlight } = retained;
      current.phase = "waiting"; current.highlight = highlight; intent = current;
      try { if (valid(current)) request(current); else dismiss(); }
      catch { dismiss(); warning(); }
    }
  };
  editor.cancelAutocomplete = () => { dismiss(false); nativeCancel(); };
  editor.requestAutocomplete = requestOptions => {
    startup = undefined;
    const captured = input();
    if (!captured) { dismiss(intent !== undefined); nativeRequest(requestOptions); return; }
    try {
      const current: Intent = { phase: "waiting", input: captured, scope: scope(), highlight: { kind: "initial" }, mode: requestOptions.force ? "force" : "regular" };
      intent = current; request(current, requestOptions.explicitTab);
    } catch { dismiss(); warning(); }
  };
  editor.handleInput = data => {
    startup = undefined;
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
    if (intent && !matchesInput(intent.input)) dismiss();
    // Older/custom editors may not trigger '$' themselves. Never issue a
    // duplicate request when this input already went through the native hook.
    if (sequence === beforeSequence && shouldCheckAfterInput(data) && input()
      && (!before || !matchesInput(before)) && !editor.isShowingAutocomplete?.()) editor.tryTriggerAutocomplete?.();
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
  if (!ui?.setEditorComponent || !ui.getEditorComponent) { startupObservation?.dispose(); return false; }
  const existingFactory = ui.getEditorComponent();
  if (isMarkedFactory(existingFactory)) { startupObservation?.dispose(); return true; }
  const CustomEditor = existingFactory ? undefined : await (editorModule ??= loadPiCustomEditor());
  if (!existingFactory && !CustomEditor) { startupObservation?.dispose(); return false; }
  let currentEditor: EditorLike | undefined;
  const factory = markFactory((tui: unknown, theme: unknown, keybindings: unknown) => {
    const startup = startupObservation?.take(tui);
    if (currentEditor) retirement.get(currentEditor)?.();
    const editor = existingFactory
      ? existingFactory(tui, theme, keybindings)
      : new CustomEditor!(tui, theme, keybindings);
    currentEditor = editor;
    return bind(wrapDollarAutocompleteEditor(editor, { keybindings, startup, warning: message => ui.notify?.(message, "warning") }));
  });
  try { ui.setEditorComponent(factory); }
  finally { startupObservation?.dispose(); }
  return true;
}
