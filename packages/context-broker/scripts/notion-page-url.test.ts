import { expect, test } from "bun:test";
import { currentNotionFixture } from "./fixtures/current-notion-source";
import { activeNotionSession } from "./fixtures/active-notion-session";
import { sourceMessageText } from "../src/session-source-snapshot";

const pageUrl = (page: string) => "https://app.notion.com/p/owned/Skill-" + page.replaceAll("-", "").toUpperCase()
  + "?v=ffffffffffffffffffffffffffffffff&source=copy_link";

test("an exact public page URL resolves its actual shared owner before any body acquisition", async () => {
  const f = await currentNotionFixture();
  const found = await f.boundary.resolveNotionReference(pageUrl(f.record.locator.page_id), [f.source], f.root);
  expect(found.record.id).toBe(f.record.id);
  expect(found.record.locator).toEqual(f.record.locator);
  expect(found.ref).toBe(f.record.ref);
  expect(f.calls.map(call => call.operation)).toEqual(["list"]);
});

test("public URL inspection does not adopt a task and URL use enters the ordinary selected graph", async () => {
  const h = await activeNotionSession();
  try {
    const root = h.record("root"), url = pageUrl(root.locator!.page_id);
    const inspected = await h.read(url);
    expect(sourceMessageText(inspected.content)).toContain(root.body!);
    expect(inspected.details).toMatchObject({ contextBrokerRead: { readStatus: { purpose: "inspect", activation_effect: "unchanged" }, snapshotId: root.snapshotId } });
    expect([...h.selected().scopes.values()].flatMap(scope => scope.graphs.map(graph => graph.purpose))).toEqual(["inspect"]);
    expect(h.f.calls.filter(call => call.operation === "consume").map(call => call.input?.purpose)).toEqual(["inspect"]);
    const used = await h.tool("notion_use").execute("url-use", { ref: url }, undefined, undefined, h.ctx);
    expect(sourceMessageText(used.content)).toContain(root.body!.trim());
    expect([...h.selected().scopes.values()].flatMap(scope => scope.graphs.filter(graph => graph.purpose === "use").flatMap(graph => graph.roots))).toEqual([root.id!]);
  } finally { await h.close(); }
});

test("public page URL spellings normalize only physical page IDs and reject unrelated HTTP targets", async () => {
  const { notionPageId, parseNotionReference, parseNativeReference } = await import("../src/native-reference");
  const id = "41f5636c-236e-810b-94e0-da577de843d0", compact = id.replaceAll("-", "");
  for (const input of [id, id.toUpperCase(), compact.toUpperCase(), "https://notion.so/" + compact,
    "https://www.notion.so/workspace/Title-" + compact, "https://app.notion.com/p/team/Title-" + compact + "?v=" + "f".repeat(32),
    "https://team.notion.site/Title-" + id.toUpperCase() + "/?source=copy_link#block"]) {
    expect(notionPageId(input)).toBe(id);
    expect(parseNotionReference(input)).toEqual({ selector: id, path: "" });
  }
  for (const input of ["https://evil.example/" + compact, "https://notion.so.evil.example/" + compact,
    "https://notion.so@evil.example/" + compact, "https://user:secret@notion.so/" + compact,
    "https://notion.so:8443/" + compact, "file://notion.so/" + compact, "https://notion.so/?p=" + compact,
    "https://notion.so/Title-" + compact + "/unrelated", "https://notion.so/Title-" + compact + "extra"]) {
    expect(notionPageId(input)).toBeUndefined();
    expect(() => parseNotionReference(input)).toThrow(expect.objectContaining({ code: "SOURCE_REFERENCE_INVALID" }));
  }
  expect(() => parseNativeReference(pageUrl(id))).toThrow(expect.objectContaining({ code: "SOURCE_REFERENCE_INVALID" }));
});

test("a physical page ref preserves an exact resource path and its snapshot owner", async () => {
  const f = await currentNotionFixture(), page = f.record.locator.page_id;
  const current = await f.boundary.resolveNotionReference("skill://" + page.toUpperCase() + "/references/guide.md", [f.source], f.root);
  expect(current.ref).toBe(f.record.ref.replace("SKILL.md", "references/guide.md"));
  const fixed = await f.boundary.resolveNotionReference("skill://" + page + "/references/guide.md?snapshot=" + f.snapshot, [f.source], f.root);
  expect(fixed.ref).toBe(f.files[1]!.ref);
  expect(f.calls.map(call => call.operation)).toEqual(["list", "files"]);
});

test("an exact page remains available in an incomplete catalog without claiming complete absence", async () => {
  const f = await currentNotionFixture(), page = f.record.locator.page_id;
  f.state.list = () => ({ ...f.state.catalog, coverage: { ...f.state.catalog.coverage, exhaustive: false,
    failed_sources: [{ id: "00000000-0000-4000-8000-000000009999", code: "VIEW_MEMBER_UNAVAILABLE" }] } });
  expect((await f.boundary.resolveNotionReference(pageUrl(page), [f.source], f.root)).record.id).toBe(f.record.id);
  await expect(f.boundary.resolveNotionReference(pageUrl("00000000-0000-4000-8000-000000009998"), [f.source], f.root))
    .rejects.toMatchObject({ code: "CATALOG_INCOMPLETE" });
  expect(f.calls.every(call => call.operation === "list")).toBe(true);
});

test("URL routing retains disabled, permission and multi-source ambiguity outcomes before acquisition", async () => {
  const f = await currentNotionFixture(), url = pageUrl(f.record.locator.page_id);
  f.record.enabled = false;
  await expect(f.boundary.resolveNotionReference(url, [f.source], f.root)).rejects.toMatchObject({ code: "CONTENT_DISABLED" });
  f.record.enabled = true;
  await expect(f.boundary.resolveNotionReference(url, [f.source, { ...f.source, id: "second-authority" }], f.root))
    .rejects.toMatchObject({ code: "SKILL_AMBIGUOUS" });
  f.state.list = () => { throw { code: "ACCESS_DENIED" }; };
  await expect(f.boundary.resolveNotionReference(url, [f.source], f.root)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(f.calls.every(call => call.operation === "list")).toBe(true);
});

test("a URL read or use preserves the old pin until explicit refresh and retains unrelated roots", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(["root", "independent"]), root = old.records.find(record => record.name === "root")!;
    const independent = old.records.find(record => record.name === "independent")!, url = pageUrl(root.locator!.page_id);
    const next = h.revise("root", "Current URL-selected instructions B.\n");
    expect(sourceMessageText((await h.read(url)).content)).toContain(root.body!);
    const inspected = await h.read(url, true);
    expect(sourceMessageText(inspected.content)).toContain(next.body!);
    expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(root.snapshotId);
    const ordinary = await h.tool("notion_use").execute("old-url", { ref: url }, undefined, undefined, h.ctx);
    expect(sourceMessageText(ordinary.content)).toContain(root.body!.trim());
    await h.tool("notion_use").execute("refresh-url", { ref: url, refresh: true }, undefined, undefined, h.ctx);
    const selected = h.selected().scopes.get(root.sourceScope!)!;
    expect(selected.bindings.get(root.id!)?.snapshot_id).toBe(next.snapshotId);
    expect(selected.bindings.get(independent.id!)?.snapshot_id).toBe(independent.snapshotId);
    expect([...selected.roots].sort()).toEqual([root.id!, independent.id!].sort());
  } finally { await h.close(); }
});

test("URL read and use retain current source failure codes and the prior selected graph", async () => {
  const h = await activeNotionSession();
  try {
    const old = await h.seed(), root = old.records.find(record => record.name === "root")!, url = pageUrl(root.locator!.page_id);
    const before = h.f.calls.filter(call => call.operation === "consume").length;
    for (const code of ["RATE_LIMITED", "NOTION_UNAVAILABLE", "ACCESS_DENIED"]) {
      h.f.state.list = () => { throw { code }; };
      await expect(h.tool("notion_use").execute("failed-url-" + code, { ref: url }, undefined, undefined, h.ctx)).rejects.toMatchObject({ code });
      await expect(h.read(url)).rejects.toThrow(code);
      expect(h.f.calls.filter(call => call.operation === "consume")).toHaveLength(before);
      expect(h.selected().scopes.get(root.sourceScope!)?.bindings.get(root.id!)?.snapshot_id).toBe(root.snapshotId);
    }
  } finally { await h.close(); }
});
