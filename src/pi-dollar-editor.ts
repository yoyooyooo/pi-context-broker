import type { EditorFactory, EditorLike, ExtensionContext } from "./types";

const FACTORY_MARKER = Symbol.for("context-broker.dollar-editor-factory");
const EDITOR_MARKER = Symbol.for("context-broker.dollar-editor-instance");
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

type PiModule = {
  CustomEditor?: new (tui: unknown, theme: unknown, keybindings: unknown) => EditorLike;
};

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
  return /(?:^|[\s([{])\$[^\s$]*$/u.test(textBeforeCursor);
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

export function wrapDollarAutocompleteEditor(editor: EditorLike): EditorLike {
  if (isMarkedEditor(editor) || typeof editor.handleInput !== "function") return editor;
  const originalHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    originalHandleInput(data);
    maybeTriggerDollarAutocomplete(editor, data);
  };
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

export async function installPiDollarAutocompleteEditor(ctx: ExtensionContext): Promise<boolean> {
  const ui = ctx.ui;
  if (!ui?.setEditorComponent || !ui.getEditorComponent) return false;
  const existingFactory = ui.getEditorComponent();
  if (isMarkedFactory(existingFactory)) return true;
  const CustomEditor = existingFactory ? undefined : await loadPiCustomEditor();
  if (!existingFactory && !CustomEditor) return false;
  const factory = markFactory((tui: unknown, theme: unknown, keybindings: unknown) => {
    const editor = existingFactory
      ? existingFactory(tui, theme, keybindings)
      : new CustomEditor!(tui, theme, keybindings);
    return wrapDollarAutocompleteEditor(editor);
  });
  ui.setEditorComponent(factory);
  return true;
}
