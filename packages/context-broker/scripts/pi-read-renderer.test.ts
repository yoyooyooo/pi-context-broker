import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPiReadRenderers } from "../src/pi-read-renderer";
import type { ReadDisplaySnapshot } from "../src/read-display";
import type { NativeReadResult, PiReadDefinition } from "../src/types";

const skillRef = "sr:S" + "a".repeat(22);
const resourceRefs = ["sr:R" + "b".repeat(22), "sr:R" + "c".repeat(22)];
const skill = (name = "repo-docs-governance"): ReadDisplaySnapshot => ({ version: 1, source: "notion", sourceId: "team-library", scope: "shared", kind: "skill", ref: skillRef, name });
const files = (): ReadDisplaySnapshot => ({ version: 1, source: "notion", sourceId: "team-library", scope: "shared", kind: "file", name: "repo-docs-governance",
  files: resourceRefs.map((ref, index) => ({ ref, path: `references/${index + 1}.md` })) });

class NativeText {
  text = "";
  setText(text: string) { this.text = text; }
}

function text(component: unknown): string {
  if (!(component instanceof NativeText)) throw new Error("The native component was replaced");
  return stripVTControlCharacters(component.text);
}

function context(args: Record<string, unknown>, changes: Record<string, unknown> = {}) {
  return { args, state: {}, toolCallId: "read-1", cwd: "/project", expanded: false,
    executionStarted: false, isPartial: false, isError: false, showImages: true,
    keyText(action: string) { expect(action).toBe("app.tools.expand"); return "ctrl+o"; },
    invalidate() { throw new Error("A read title must not schedule another render"); }, ...changes };
}

function fixture(getDisplay?: Parameters<typeof createPiReadRenderers>[0]["getDisplay"]) {
  const calls: unknown[] = [], results: unknown[] = [], styles: Array<{ color: string; text: string }> = [];
  const resultComponent = new NativeText(); resultComponent.setText("native result");
  const native: Pick<PiReadDefinition, "renderCall" | "renderResult"> = {
    renderCall(args, theme, ctx) {
      calls.push({ args, theme, context: ctx });
      const component = ctx !== null && typeof ctx === "object" && "lastComponent" in ctx && ctx.lastComponent instanceof NativeText ? ctx.lastComponent : new NativeText();
      component.setText(`native read ${args.path}`);
      return component;
    },
    renderResult(result, options, theme, ctx) { results.push({ result, options, theme, context: ctx }); return resultComponent; },
  };
  const renderers = createPiReadRenderers({ native, getDisplay });
  const theme = { fg(color: string, value: string) { styles.push({ color, text: value }); return value; } };
  const renderCall = (args: Record<string, unknown>, ctx = context(args)) => renderers.renderCall?.(args, theme, ctx);
  const renderResult = (result: NativeReadResult, ctx: ReturnType<typeof context>, options: unknown = { expanded: ctx.expanded, isPartial: ctx.isPartial }) => renderers.renderResult?.(result, options, theme, ctx);
  return { renderers, renderCall, renderResult, calls, results, styles, theme, resultComponent };
}

const resultWith = (snapshot: unknown): NativeReadResult => ({ content: [{ type: "text", text: "original body" }], details: { contextBrokerReadDisplay: snapshot } });

test("saved Notion details relabel the native header in the first replay frame", () => {
  const f = fixture(() => { throw new Error("Replay must not consult current metadata"); });
  const args = { path: skillRef }, ctx = context(args);
  const result: NativeReadResult = JSON.parse(JSON.stringify(resultWith(skill())));
  const header = f.renderCall(args, ctx);
  expect(text(header)).toBe(`native read ${skillRef}`);
  expect(f.renderResult(result, ctx)).toBe(f.resultComponent);
  expect(text(header)).toBe("[skill@notion] repo-docs-governance (ctrl+o to expand)");
  expect(f.calls).toEqual([{ args, theme: f.theme, context: ctx }]);
  expect(f.results[0]).toMatchObject({ result, context: ctx });
  expect(result.content).toEqual([{ type: "text", text: "original body" }]);
  expect(f.renderers).not.toHaveProperty("renderShell");
});

test("live metadata is confined to an executing call and saved details win on completion", () => {
  const lookups: unknown[] = [], f = fixture(input => { lookups.push(input); return skill("current name"); });
  const args = { path: skillRef }, ctx = context(args, { executionStarted: true, isPartial: true });
  const header = f.renderCall(args, ctx);
  expect(text(header)).toContain("current name");
  expect(lookups).toEqual([{ args, toolCallId: "read-1" }]);
  f.renderResult(resultWith(skill("saved name")), ctx);
  expect(text(header)).toBe("[skill@notion] saved name (ctrl+o to expand)");
  const completed = { ...ctx, isPartial: false, lastComponent: header };
  expect(f.renderCall(args, completed)).toBe(header);
  f.renderResult(resultWith(skill("saved name")), completed);
  expect(text(header)).toContain("saved name");
  expect(lookups).toHaveLength(1);
});

test("expansion shows original refs and folding reuses the native Text and saved title", () => {
  const f = fixture(), args = { path: skillRef }, ctx = context(args);
  const header = f.renderCall(args, ctx), result = resultWith(skill());
  f.renderResult(result, ctx);
  const expanded = { ...ctx, expanded: true, lastComponent: header };
  expect(f.renderCall(args, expanded)).toBe(header);
  expect(f.renderResult(result, expanded)).toBe(f.resultComponent);
  expect(text(header)).toBe(`native read ${skillRef}`);
  const collapsed = { ...ctx, lastComponent: header };
  f.renderCall(args, collapsed); f.renderResult(result, collapsed);
  expect(text(header)).toBe("[skill@notion] repo-docs-governance (ctrl+o to expand)");
});

test("resource titles carry their owner and relative file, with a count for the remaining batch", () => {
  const display = files();
  if (display.kind !== "file") throw new Error("Expected file display");
  const f = fixture(), batchArgs = { paths: resourceRefs }, batch = context(batchArgs);
  const header = f.renderCall(batchArgs, batch);
  f.renderResult(resultWith(display), batch);
  expect(text(header)).toBe("[file@notion] repo-docs-governance / references/1.md (+1 file) (ctrl+o to expand)");
  expect(f.calls[0]).toMatchObject({ args: { path: resourceRefs.join(", ") } });
  const scalarArgs = { path: resourceRefs[0] }, scalar = context(scalarArgs);
  const scalarHeader = f.renderCall(scalarArgs, scalar);
  f.renderResult(resultWith({ ...display, files: display.files.slice(0, 1) }), scalar);
  expect(text(scalarHeader)).toBe("[file@notion] repo-docs-governance / references/1.md (ctrl+o to expand)");
  const expanded = { ...batch, expanded: true, lastComponent: header };
  f.renderCall(batchArgs, expanded); f.renderResult(resultWith(display), expanded);
  expect(text(header)).toBe(`native read ${resourceRefs.join(", ")}`);
});

test("old logs and unknown or mismatched snapshots retain native read rendering", () => {
  const f = fixture(() => { throw new Error("Completed history must not resolve names"); });
  const badSnapshots = [undefined, null, {}, { ...skill(), version: 2 }, { ...skill(), source: "local" },
    { ...skill(), kind: "unknown" }, { ...skill(), ref: "another-ref" }, { ...skill(), name: "\x1b[2J\n" },
    { ...skill(), scope: undefined }, { ...skill(), scope: "" }, { ...skill(), sourceId: " " },
    { ...skill(), sourceLabel: 7 }, { ...files(), files: [] },
    { ...files(), files: [{ ref: skillRef, path: null }] }, { ...files(), files: [{ ref: skillRef, path: "\x1b[2J" }] }];
  for (const snapshot of badSnapshots) {
    const args = { path: skillRef }, ctx = context(args), header = f.renderCall(args, ctx);
    f.renderResult(resultWith(snapshot), ctx);
    expect(text(header)).toBe(`native read ${skillRef}`);
  }
  for (const path of ["/local/SKILL.md", "/local/readme.md", "sr:C" + "z".repeat(22)]) {
    const args = { path }, ctx = context(args), header = f.renderCall(args, ctx);
    f.renderResult({ content: [{ type: "text", text: "legacy body" }] }, ctx);
    expect(text(header)).toBe(`native read ${path}`);
  }
  const args = { paths: [...resourceRefs].reverse() }, ctx = context(args), header = f.renderCall(args, ctx);
  f.renderResult(resultWith(files()), ctx);
  expect(text(header)).toBe(`native read ${args.paths.join(", ")}`);
});

test("unknown persisted metadata resets an in-flight title instead of applying live guesses", () => {
  const f = fixture(() => skill()), args = { path: skillRef }, ctx = context(args, { executionStarted: true, isPartial: true });
  const header = f.renderCall(args, ctx);
  expect(text(header)).toContain("[skill@notion]");
  f.renderResult(resultWith({ ...skill(), version: 2 }), ctx);
  expect(text(header)).toBe(`native read ${skillRef}`);
});

test("labels are single-line plain text while ambiguous source labels use Pi's dim style", () => {
  const display = { ...files(), name: "\x1b[31mrepo\x1b[0m\n docs\t\u202e", sourceLabel: "Team\x00 Library\x1b]8;;https://invalid.example\x07\x1b]8;;\x07",
    files: [{ ref: resourceRefs[0], path: "references/\n policy.md\x1b[2J" }] };
  const before = JSON.stringify(display), f = fixture(), args = { path: resourceRefs[0] }, ctx = context(args, { keyText: () => "alt+o" });
  const header = f.renderCall(args, ctx);
  f.renderResult(resultWith(display), ctx);
  expect(text(header)).toBe("[file@notion] repo docs / references/ policy.md · Team Library (alt+o to expand)");
  expect(f.styles).toContainEqual({ color: "dim", text: " · Team Library" });
  expect(JSON.stringify(display)).toBe(before);
});

test("line windows and user keybindings remain visible", () => {
  const windows: Array<{ args: Record<string, unknown>; suffix: string }> = [
    { args: { offset: 2, limit: 3 }, suffix: ":2-4" }, { args: { limit: 4 }, suffix: ":1-4" },
    { args: { offset: 8 }, suffix: ":8" }, { args: { offset: "2", limit: "3" }, suffix: ":2-4" },
    { args: { offset: Number.POSITIVE_INFINITY }, suffix: "" }, { args: { offset: null, limit: null }, suffix: "" },
  ];
  for (const window of windows) {
    const f = fixture(), args = { path: skillRef, ...window.args }, ctx = context(args, { keyText: () => "ctrl+shift+o" });
    const header = f.renderCall(args, ctx); f.renderResult(resultWith(skill()), ctx);
    expect(text(header)).toBe(`[skill@notion] repo-docs-governance${window.suffix} (ctrl+shift+o to expand)`);
  }
});

test("native images, errors, partial output and truncation details pass through unchanged", () => {
  const f = fixture(), args = { path: skillRef }, ctx = context(args, { isError: true, isPartial: true });
  const header = f.renderCall(args, ctx), options = { expanded: false, isPartial: true };
  const result: NativeReadResult = { content: [{ type: "text", text: "failed" }, { type: "image", data: "image-bytes", mimeType: "image/png" }],
    details: { contextBrokerReadDisplay: skill(), truncation: { truncated: true, outputLines: 10 }, imageUnsupportedByModel: "model" }, isError: true };
  expect(f.renderResult(result, ctx, options)).toBe(f.resultComponent);
  expect(f.results).toEqual([{ result, options, theme: f.theme, context: ctx }]);
  expect(text(header)).toContain("[skill@notion]");
});

test("headers from concurrent tool components remain separate", () => {
  const f = fixture(), args = { path: skillRef }, one = context(args), two = context(args, { toolCallId: "read-2" });
  const first = f.renderCall(args, one), second = f.renderCall(args, two);
  f.renderResult(resultWith(skill("first")), one); f.renderResult(resultWith(skill("second")), two);
  expect(text(first)).toBe("[skill@notion] first (ctrl+o to expand)");
  expect(text(second)).toBe("[skill@notion] second (ctrl+o to expand)");
});

test("missing optional renderer capabilities leave the native component and fallback intact", () => {
  expect(createPiReadRenderers({ native: {} })).toEqual({});
  const component = { native: true }, native = { renderCall: () => component, renderResult: () => component };
  const renderers = createPiReadRenderers({ native, getDisplay: () => skill() });
  expect(renderers.renderCall?.({ path: skillRef }, {}, {})).toBe(component);
  expect(renderers.renderResult?.(resultWith(skill()), {}, {}, {})).toBe(component);
});
