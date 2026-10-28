import type { AutocompleteItem, AutocompleteProvider, EditorLike, ExtensionContext } from "./types";
import { dollarAutocompletePrefixAtCursor } from "./dollar";
// @ts-ignore Optional OMP host export, rewritten by its extension loader.
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components";
// @ts-ignore Optional OMP host theme, rewritten by its extension loader.
import { theme } from "@oh-my-pi/pi-coding-agent";

type Decoration = { from: number; to: number; s: string; fx?: string };
type NativeDescription = {
  readonly k: string;
  readonly p?: { readonly role?: string; readonly size?: string; readonly aria?: string };
  readonly c?: readonly unknown[];
};
type OmpEditor = EditorLike & {
  prediction?: () => string | undefined;
  atoms: ReadonlyMap<string, string>;
  textRevision: number;
  atomsRevision: number;
  atomicTokenPattern: RegExp;
  getCursor(): { line: number; col: number };
  vimMode?: string;
  getLines(): string[];
  isShowingAutocomplete(): boolean;
  collapseToAtom(line: number, start: number, end: number, label: string, expansion: string): void;
  setAutocompleteProvider(provider: AutocompleteProvider): void;
  setTextAssistProvider(provider: unknown): void;
  decorateText(text: string, context: unknown): string;
  describeDecorations(lines: readonly string[]): readonly Decoration[];
  describe(context: unknown): NativeDescription;
  handleInput(data: string): void;
  handleNativeEvent(event: { type: string }): void;
};
const OmpCustomEditor = CustomEditor as new (...args: unknown[]) => OmpEditor;
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function installOmpDollarAutocompleteEditor(ctx: ExtensionContext, bind: (editor: EditorLike) => EditorLike): Promise<boolean> {
  if (!ctx.hasUI || !ctx.ui?.setEditorComponent) return false;
  class DollarEditor extends OmpCustomEditor {
    [key: symbol]: unknown;
    private declare assist: unknown;
    private triggering = false;
    private brokerRevision = -1;
    private brokerPattern: RegExp | undefined;
    private basePattern: RegExp;
    private generation = 0;
    private observedRevision = -1;
    private observedLine = -1;
    private observedMode: string | undefined;
    private observedCol = -1;
    private draftLines: string[] = [];
    private brokerPopup = false;
    private readonly pending = new Set<AbortController>();
    private readonly wideDescriptions = new WeakMap<NativeDescription, NativeDescription>();

    constructor(tui: unknown, editorTheme: unknown, keybindings: unknown) {
      super(tui, editorTheme, keybindings);
      this.basePattern = this.atomicTokenPattern;
      const decorate = this.decorateText.bind(this);
      const describe = this.describeDecorations.bind(this);
      this.decorateText = (text, context) => {
        this.atomicTokenPattern = this.basePattern;
        const rendered = decorate(text, context);
        this.basePattern = this.atomicTokenPattern;
        this.syncBrokerAtoms();
        return this.brokerPattern ? rendered.replace(this.brokerPattern, label =>
          `${theme.getBgAnsi("customMessageBg")}${theme.getFgAnsi("customMessageLabel")}\x1b[1m${label}\x1b[22m\x1b[39m\x1b[49m`) : rendered;
      };
      this.describeDecorations = lines => {
        this.atomicTokenPattern = this.basePattern;
        const decorations = describe(lines);
        this.basePattern = this.atomicTokenPattern;
        this.syncBrokerAtoms();
        if (!this.brokerPattern) return decorations;
        const result = [...decorations];
        const text = lines.join("\n");
        for (const match of text.matchAll(this.brokerPattern)) {
          result.push({ from: match.index, to: match.index + match[0].length, s: "customMessageLabel strong" });
        }
        return result.sort((a, b) => a.from - b.from);
      };
    }

    describe(context: unknown): NativeDescription {
      const described = super.describe(context);
      if (!this.isShowingAutocomplete()) return described;
      const cursor = this.getCursor();
      if (dollarAutocompletePrefixAtCursor(this.getLines(), cursor.line, cursor.col) === undefined) return described;
      const cached = this.wideDescriptions.get(described);
      if (cached) return cached;
      const children = described.c?.map(child => {
        const node = child as NativeDescription | undefined;
        return node?.k === "overlay" && node.p?.role === "omp.autocomplete"
          ? { ...node, p: { ...node.p, aria: "Context Broker completions", size: "lg" } }
          : child;
      });
      const wide = { ...described, c: children };
      this.wideDescriptions.set(described, wide);
      return wide;
    }

    private syncBrokerAtoms(): void {
      if (this.brokerRevision !== this.atomsRevision) {
        const labels = [...this.atoms].filter(([, expansion]) => expansion.startsWith("$")).map(([label]) => escapeRegex(label));
        this.brokerPattern = labels.length ? new RegExp(labels.sort((a, b) => b.length - a.length).join("|"), "gu") : undefined;
        this.brokerRevision = this.atomsRevision;
      }
      const source = this.brokerPattern ? `${this.basePattern.source}|(?:${this.brokerPattern.source})` : this.basePattern.source;
      if (this.atomicTokenPattern.source !== source) this.atomicTokenPattern = new RegExp(source, this.basePattern.flags);
    }

    private observeCursor(): number {
      const cursor = this.getCursor();
      if (this.observedRevision !== this.textRevision || this.observedLine !== cursor.line || this.observedCol !== cursor.col || this.observedMode !== this.vimMode) {
        if (this.observedRevision !== this.textRevision) this.draftLines = this.getLines();
        this.observedRevision = this.textRevision;
        this.observedLine = cursor.line;
        this.observedCol = cursor.col;
        this.observedMode = this.vimMode;
        this.generation++;
        for (const controller of this.pending) controller.abort();
      }
      return this.generation;
    }

    setAutocompleteProvider(provider: AutocompleteProvider): void {
      this.generation++;
      for (const controller of this.pending) controller.abort();
      const owned = new WeakMap<AutocompleteItem, { generation: number; prefix: string }>();
      // Native providers use private fields; inherited methods must keep their original receiver.
      const wrapped: AutocompleteProvider = {
        getInlineHint: provider.getInlineHint?.bind(provider),
        trySyncSlashCompletion: provider.trySyncSlashCompletion?.bind(provider),
        trySyncInlineReplace: provider.trySyncInlineReplace?.bind(provider),
        shouldTriggerFileCompletion: provider.shouldTriggerFileCompletion?.bind(provider),
        getSuggestions: (...args) => provider.getSuggestions(...args),
        applyCompletion: (...args) => provider.applyCompletion(...args),
      };
      wrapped.getSuggestions = async (lines, line, col, options, onPartial) => {
        const generation = this.observeCursor();
        const prefix = dollarAutocompletePrefixAtCursor(lines, line, col);
        if (prefix === undefined) {
          this.brokerPopup = false;
          return provider.getSuggestions(lines, line, col, options, onPartial);
        }
        const hostSignal = options && ("signal" in options ? options.signal : options);
        const controller = new AbortController();
        const abort = () => controller.abort();
        hostSignal?.addEventListener("abort", abort, { once: true });
        if (hostSignal?.aborted) controller.abort();
        this.pending.add(controller);
        const current = () => !controller.signal.aborted && generation === this.observeCursor()
          && line === this.observedLine && col === this.observedCol
          && lines.length === this.draftLines.length && lines.every((text, index) => text === this.draftLines[index]);
        const publish = (result: { items: AutocompleteItem[]; prefix: string } | null) => {
          if (!current() || !result || result.prefix !== prefix) return null;
          for (const item of result.items) owned.set(item, { generation, prefix });
          this.brokerPopup = result.items.length > 0;
          return result;
        };
        try {
          const result = await provider.getSuggestions(lines, line, col,
            options && "signal" in options ? { ...options, signal: controller.signal } : controller.signal,
            onPartial ? (partial) => { const published = publish(partial); if (published) onPartial(published); } : undefined);
          return publish(result);
        } finally {
          this.pending.delete(controller);
          hostSignal?.removeEventListener("abort", abort);
        }
      };
      wrapped.getForceFileSuggestions = (lines, line, col, signal) => dollarAutocompletePrefixAtCursor(lines, line, col) !== undefined
        ? wrapped.getSuggestions(lines, line, col, signal)
        : provider.getForceFileSuggestions?.(lines, line, col, signal) ?? provider.getSuggestions(lines, line, col, signal);
      wrapped.applyCompletion = (lines, line, col, item, prefix) => {
        const owner = owned.get(item);
        if (!owner) return provider.applyCompletion(lines, line, col, item, prefix);
        if (owner.generation !== this.observeCursor() || owner.prefix !== prefix
          || line !== this.observedLine || col !== this.observedCol
          || lines.length !== this.draftLines.length || !lines.every((text, index) => text === this.draftLines[index])
          || dollarAutocompletePrefixAtCursor(lines, line, col) !== prefix) return { lines, cursorLine: line, cursorCol: col };
        const result = provider.applyCompletion(lines, line, col, item, prefix);
        if (!item.value.startsWith("$")) return result;
        const start = col - prefix.length;
        const end = start + item.value.length;
        return { ...result, onApplied: () => {
          result.onApplied?.();
          // Native atoms own editing/history; submit expands back to broker syntax.
          this.collapseToAtom(line, start, end, `${theme.symbol("icon.extensionSkill")} ${item.value}`, item.value);
          this.syncBrokerAtoms();
        } };
      };
      super.setAutocompleteProvider(wrapped);
      // Provider installation may follow the user's first keystroke without another event.
      queueMicrotask(() => {
        this.observeCursor();
        if (this.brokerPopup && this.isShowingAutocomplete()) super.handleInput("\x1b");
        this.brokerPopup = false;
        this.trigger();
      });
    }

    setTextAssistProvider(provider: unknown): void {
      this.assist = provider;
      super.setTextAssistProvider(provider);
    }

    private trigger(): void {
      if (this.triggering || this.isShowingAutocomplete()) return;
      const cursor = this.getCursor();
      if (this.vimMode?.startsWith("visual")) return;
      if (dollarAutocompletePrefixAtCursor(this.draftLines, cursor.line, cursor.col) === undefined) return;
      const text = this.draftLines[cursor.line] ?? "";
      for (const [label] of this.atoms) {
        let start = text.indexOf(label);
        while (start !== -1) {
          if (cursor.col > start && cursor.col <= start + label.length) return;
          start = text.indexOf(label, start + label.length);
        }
      }
      this.triggering = true;
      const prediction = this.prediction;
      this.prediction = undefined;
      super.setTextAssistProvider(undefined);
      try {
        super.handleInput("\t");
      } finally {
        super.setTextAssistProvider(this.assist);
        this.prediction = prediction;
        this.triggering = false;
      }
    }

    private refreshAfterEvent(before: number): void {
      if (this.observeCursor() === before) return;
      // OMP exposes cancellation through its ordinary Escape handling, not a public cancel method.
      if (this.brokerPopup && this.isShowingAutocomplete()) super.handleInput("\x1b");
      this.brokerPopup = false;
      this.trigger();
    }

    handleInput(data: string): void {
      const before = this.observeCursor();
      super.handleInput(data);
      this.refreshAfterEvent(before);
    }

    handleNativeEvent(event: { type: string }): void {
      const before = this.observeCursor();
      super.handleNativeEvent(event);
      this.refreshAfterEvent(before);
    }
  }
  ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => bind(new DollarEditor(tui, editorTheme, keybindings)));
  return true;
}
