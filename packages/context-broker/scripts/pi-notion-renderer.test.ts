import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createPiNotionRenderers } from "../src/pi-notion-renderer";
import { renderSkillPreparationModel, type SkillPreparationModel } from "../src/skill-context-projection";
import type { NativeReadResult } from "../src/types";

class Text {
  constructor(public text: string, _x = 0, _y = 0) {}
  setText(text: string) { this.text = text; }
  render(_width: number) { return this.text.split("\n"); }
  invalidate() {}
}
class Markdown extends Text {
  constructor(text: string, x: number, y: number, _theme: unknown) { super(text, x, y); }
}
class Container {
  children: Array<Text | Container> = [];
  addChild(child: Text | Container) { this.children.push(child); }
  render(width: number): string[] { return this.children.flatMap(child => child.render(width)); }
  invalidate() {}
}
const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
const ui = { Text, Markdown, Container, getMarkdownTheme: () => ({}) };
const ref = (letter: string) => "sr:S" + letter.repeat(22);
const rootA = ref("a"), rootB = ref("b"), required = ref("c");

function component(value: unknown): Text | Container {
  if (value instanceof Text || value instanceof Container) return value;
  throw new Error("Renderer must return a usable TUI component");
}
function visible(value: unknown) { return stripVTControlCharacters(component(value).render(100).join("\n")); }
function markdown(value: unknown): string[] {
  const item = component(value);
  return item instanceof Markdown ? [item.text] : item instanceof Container ? item.children.flatMap(markdown) : [];
}
function context(args: Record<string, unknown> = {}, changes: Record<string, unknown> = {}) {
  return { args, state: {}, toolCallId: "notion-1", expanded: false, isPartial: false, isError: false,
    executionStarted: true, argsComplete: true, cwd: "/owned/run", showImages: true,
    keyText: (action: string) => { expect(action).toBe("app.tools.expand"); return "alt+o"; },
    invalidate() {}, ...changes };
}
function result(payload: unknown, details: unknown = { receipt: "untouched" }): NativeReadResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details };
}
function fixture(kind: "list" | "use", args: Record<string, unknown> = {}, changes: Record<string, unknown> = {}, shared = createPiNotionRenderers(ui)) {
  const renderer = shared[kind], ctx = context(args, changes);
  const call = renderer.renderCall, renderResult = renderer.renderResult;
  if (!call || !renderResult) throw new Error("Missing Pi renderer");
  let header = component(call(args, theme, ctx));
  return {
    get header() { return header; }, ctx, renderer,
    render(value: NativeReadResult, overrides: Record<string, unknown> = {}) {
      const current = { ...ctx, ...overrides };
      return component(renderResult(value, { expanded: current.expanded, isPartial: current.isPartial }, theme, current));
    },
    call(overrides: Record<string, unknown> = {}) {
      header = component(call(args, theme, { ...ctx, lastComponent: header, ...overrides }));
      return header;
    },
  };
}
const record = (name = "flclash-kit", source = "daily") => ({
  kind: "skill", name, description: "配置和维护桌面宿主。\n保留完整描述。",
  ref: "sr:C" + "d".repeat(22), source, availability: "available", in_default_view: false,
});
function catalog(records = [record()]) {
  return { ok: true, state: "known", count: records.length, total_count: records.length,
    has_more: false, next_cursor: null, records, failures: [] as Array<{ source: string; code: string }>,
    freshness: { sources: [{ source: "daily", policy: "refresh", validated_at: "2026-11-24T12:00:00Z",
      age_ms: 1, max_age_ms: 300000, stale: false }] },
    coverage: { exhaustive: true, sources: [{ source: "daily", exhaustive: true }] } };
}
function prepared(): SkillPreparationModel {
  const related = { ref: required, kind: "skill", name: "shared-rule", description: "共同约束", availability: "available" };
  const directory = { files: [{ path: "references/guide.md", ref: "sr:R" + "e".repeat(22), bytes: 87, description: "补充文档" }],
    required: [related], candidates: [], references: [] };
  return { ok: true, status: "ready", purpose: "use", roots: [rootA, rootB], records: [
    { name: "中文 skill-a", kind: "skill", ref: rootA, content: "# 标题\n\n完整正文，含 \"引号\"、literal \\n 和代码。\n\n最后一行。", directory },
    { name: "skill-b", kind: "skill", ref: rootB, content: "第二个根正文", directory },
    { name: "shared-rule", kind: "skill", ref: required, content: "完整依赖正文" },
  ] };
}
function preparedResult(model = prepared()): NativeReadResult {
  return { content: [{ type: "text", text: renderSkillPreparationModel(model).content }],
    details: { contextBrokerPreparation: { version: 2, proof: "original proof" } } };
}

test("list renders names and page count while keeping raw payload untouched", () => {
  const f = fixture("list", { query: "flclash", refresh: true }), payload = catalog(), value = result(payload, payload);
  const before = JSON.stringify(value), body = f.render(value);
  expect(visible(f.header)).toContain("[list@notion]");
  expect(visible(f.header)).toContain("flclash");
  expect(visible(f.header) + visible(body)).toContain("flclash-kit");
  expect(visible(f.header) + visible(body)).toMatch(/1 result/);
  expect(visible(f.header) + visible(body)).not.toContain('{"ok"');
  expect(JSON.stringify(value)).toBe(before);
});

test("pagination distinguishes this page from all matching records", () => {
  const payload = { ...catalog(), total_count: 7, has_more: true, next_cursor: "1.cursor" };
  const f = fixture("list", { query: "kit", limit: 1 }), collapsed = f.render(result(payload));
  const view = visible(f.header) + visible(collapsed);
  expect(view).toContain("7");
  expect(view).toMatch(/more|of|page/i);
  const expanded = f.render(result(payload), { expanded: true });
  expect(visible(expanded)).toContain("1.cursor");
  expect(visible(expanded)).toContain("保留完整描述");
});

test("fresh complete online empty metadata can establish no matches", () => {
  const f = fixture("list", { query: "missing" }), body = f.render(result(catalog([])));
  expect(visible(f.header) + visible(body)).toMatch(/no matches/i);
});

test("stale, offline, unknown or mismatched freshness never establishes absence", () => {
  const base = catalog([]);
  const variants = [
    { ...base, freshness: { sources: [{ ...base.freshness.sources[0], stale: true }] } },
    { ...base, freshness: { sources: [{ ...base.freshness.sources[0], policy: "offline" }] } },
    { ...base, freshness: { sources: [{ ...base.freshness.sources[0], policy: "pinned" }] } },
    { ...base, freshness: { sources: [{ ...base.freshness.sources[0], stale: null }] } },
    { ...base, freshness: { sources: [] } },
    { ...base, freshness: { sources: [{ ...base.freshness.sources[0], source: "another-source" }] } },
    { ...base, coverage: { exhaustive: null, sources: [{ source: "daily", exhaustive: null }] } },
    { ...base, coverage: { exhaustive: true, sources: [] } },
  ];
  for (const value of variants) {
    const f = fixture("list", { query: "missing", refresh: true }), body = f.render(result(value));
    expect(visible(f.header) + visible(body)).not.toMatch(/no matches|refreshed/i);
  }
});

test("source failure remains visible while surviving matches are shown", () => {
  const base = catalog();
  const payload = { ...base, failures: [{ source: "team", code: "ACCESS_DENIED" }],
    coverage: { exhaustive: false, sources: [...base.coverage.sources, { source: "team", exhaustive: false }] } };
  const f = fixture("list"), body = f.render(result(payload));
  expect(visible(f.header) + visible(body)).toMatch(/partial/i);
  expect(visible(f.header) + visible(body)).toContain("flclash-kit");
  expect(visible(f.render(result(payload), { expanded: true }))).toContain("ACCESS_DENIED");
});

test("content search never reports absence and preserves match context when expanded", () => {
  const payload = { ok: true, state: "known", search_in: "content", source: "daily", count: 1,
    next_cursor: null, pagination: "not_supported", coverage: "remote_non_exhaustive", exhaustive: false, partial: true,
    records: [{ ...record(), match: { kind: "notion_remote_match", pageId: "page", title: "日志指南",
      snippet: "需要保留的命中片段", representation: "supporting_file" } }],
    notices: [{ code: "SEARCH_PARTIAL", message: "索引只覆盖部分内容" }],
    match_semantics: "Remote matches do not prove exact bytes." };
  const f = fixture("list", { query: "日志", search_in: "content" });
  const body = f.render(result(payload));
  expect(visible(f.header) + visible(body)).toMatch(/partial|non.exhaustive/i);
  const expanded = visible(f.render(result(payload), { expanded: true }));
  expect(expanded).toContain("需要保留的命中片段");
  expect(expanded).toContain("索引只覆盖部分内容");
  const empty = { ...payload, count: 0, records: [], partial: false };
  const g = fixture("list"), emptyBody = g.render(result(empty));
  expect(visible(g.header) + visible(emptyBody)).not.toMatch(/no matches/i);
});

test("content authorization and cancellation failures do not need Pi isError", () => {
  for (const state of ["auth_required", "cancelled", "unsupported", "failed"]) {
    const payload = { ok: false, search_in: "content", state,
      error: { code: "MCP_AUTH_REQUIRED", message: "Original actionable error" }, exhaustive: false, next_cursor: null };
    const f = fixture("list", { search_in: "content", query: "test" }), body = f.render(result(payload));
    expect(visible(f.header) + visible(body)).toMatch(/auth|cancel|unsupported|failed/i);
    expect(visible(body)).toContain("Original actionable error");
    expect(visible(f.header) + visible(body)).not.toMatch(/no matches|loaded/i);
  }
});

test("use shows selected root names and counts a shared required Skill once", () => {
  const f = fixture("use", { ref: [rootA, rootB] }), value = preparedResult();
  const before = JSON.stringify(value), body = f.render(value);
  const view = visible(f.header) + visible(body);
  expect(view).toContain("[skill@notion]");
  expect(view).toContain("中文 skill-a");
  expect(view).toContain("loaded");
  expect(view).toMatch(/1 required/);
  expect(view).not.toContain("完整正文");
  expect(view).not.toContain('{"ok"');
  expect(JSON.stringify(value)).toBe(before);
  const expanded = f.render(value, { expanded: true });
  const expandedText = visible(expanded);
  expect(expandedText).toContain("第二个根正文");
  expect(expandedText).toContain("完整依赖正文");
  expect(expandedText).toContain("references/guide.md");
  expect(markdown(expanded).some(text => text.includes(prepared().records[0]!.content))).toBe(true);
  expect(JSON.stringify(value)).toBe(before);
});

test("refresh success says reloaded without claiming a new version", () => {
  const f = fixture("use", { ref: rootA, refresh: true });
  f.render(preparedResult());
  expect(visible(f.header)).toMatch(/reloaded/);
  expect(visible(f.header)).not.toMatch(/updated/);
});

test("loading and failure cannot reuse a prior success label", () => {
  const f = fixture("use", { ref: rootA });
  f.render(preparedResult());
  expect(visible(f.header)).toMatch(/loaded/);
  const failure = result({ ok: false, status: "failed", error: { code: "ROOT_ROLE_CONFLICT", message: "Refresh roots together." },
    diagnostic: { exact: "preserve this evidence" } });
  const body = f.render(failure);
  expect(visible(f.header) + visible(body)).toContain("ROOT_ROLE_CONFLICT");
  expect(visible(f.header)).not.toMatch(/loaded/);
  expect(visible(f.render(failure, { expanded: true }))).toContain("preserve this evidence");
  const g = fixture("use", { ref: rootA }, { isPartial: true });
  const pending = g.render({ content: [] });
  expect(visible(g.header) + visible(pending)).toMatch(/loading|preparing/i);
  expect(visible(g.header) + visible(pending)).not.toMatch(/loaded/);
});

test("Pi isError takes precedence over a success-shaped result", () => {
  const f = fixture("use", { ref: rootA }, { isError: true });
  const body = f.render(preparedResult());
  expect(visible(f.header) + visible(body)).toMatch(/failed|error/i);
  expect(visible(f.header)).not.toMatch(/loaded/);
});

test("unknown or malformed results keep the original text available", () => {
  for (const kind of ["list", "use"] as const) {
    for (const text of ["legacy plain output\nlast line", '{"newVersion":99,"records":"unrecognized"}', '{"ok":']) {
      const f = fixture(kind), body = f.render({ content: [{ type: "text", text }] }, { expanded: true });
      expect(visible(body)).toContain(text);
    }
  }
});

test("replay derives display from serialized result and rows never share names", () => {
  const shared = createPiNotionRenderers(ui);
  const first = fixture("use", { ref: rootA }, {}, shared);
  const second = fixture("use", { ref: rootA }, {}, shared);
  const one = prepared(), two = prepared();
  one.records[0] = { ...one.records[0]!, name: "historic-name" };
  two.records[0] = { ...two.records[0]!, name: "other-row" };
  first.render(JSON.parse(JSON.stringify(preparedResult(one))));
  second.render(preparedResult(two));
  expect(visible(first.header)).toContain("historic-name");
  expect(visible(first.header)).not.toContain("other-row");
  expect(visible(second.header)).toContain("other-row");
  first.call({ expanded: true });
  first.render(preparedResult(one), { expanded: true });
  first.call();
  first.render(preparedResult(one));
  expect(visible(first.header)).toContain("historic-name");
});

test("titles sanitize terminal controls and honor configured expand keys", () => {
  const model = prepared();
  model.records[0] = { ...model.records[0]!, name: "\x1b[31m中文\n名称\u202e\x1b[0m" };
  const f = fixture("use", { ref: rootA });
  f.render(preparedResult(model));
  const title = visible(f.header);
  expect(title).toContain("中文 名称");
  expect(title).not.toContain("\u202e");
  expect(title).not.toContain("\n");
  expect(title).toContain("alt+o");
});

test("denied candidates retain their reason and inconsistent pagination stays raw", () => {
  const denied = { ...record(), availability: "unavailable", error_code: "CONTENT_DISABLED" };
  const f = fixture("list"), value = result(catalog([denied]));
  const body = f.render(value);
  expect(visible(f.header) + visible(body)).toContain("CONTENT_DISABLED");
  for (const payload of [
    { ...catalog([]), has_more: true, next_cursor: null },
    { ...catalog([]), has_more: false, next_cursor: "next" },
    { ...catalog([]), has_more: true, next_cursor: "", total_count: 1 },
  ]) {
    const g = fixture("list"), malformed = result(payload);
    const output = g.render(malformed, { expanded: true });
    expect(visible(g.header)).not.toMatch(/no matches/);
    expect(visible(output)).toContain(JSON.stringify(payload));
  }
});

test("the same theme proxy can change colors between renders", () => {
  let color = "old-theme";
  const changingTheme = { fg: (_name: string, value: string) => color + ":" + value };
  const renderer = createPiNotionRenderers(ui).list;
  if (!renderer.renderCall || !renderer.renderResult) throw new Error("Missing renderers");
  const args = { query: "theme" }, ctx = context(args), value = result(catalog());
  const header = renderer.renderCall(args, changingTheme, ctx);
  const old = renderer.renderResult(value, { expanded: true, isPartial: false }, changingTheme, ctx);
  expect(visible(old)).toContain("old-theme:");
  color = "new-theme";
  const current = renderer.renderResult(value, { expanded: true, isPartial: false }, changingTheme, ctx);
  expect(visible(current)).toContain("new-theme:");
  expect(visible(current)).not.toContain("old-theme:");
  expect(visible(header)).toContain("new-theme:");
});
