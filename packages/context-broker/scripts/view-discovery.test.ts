import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotionFixture, database, firstViewId, secondViewId } from "../../../scripts/notion-integration-fixture.mjs";
import { listNotionViews } from "../src/notion-source";
import { notionDirectorySelections, resolveViewDiscovery, sessionViews, VIEW_SELECTION_ENTRY } from "../src/view-discovery";
import { viewSystemPrompt } from "../src/view-prompt";
import { normalizeSources } from "../src/sources";
import type { ExtensionContext, NotionDirectory, NotionDirectoryObservation, SessionEntry, SkillRecord, SourceConfig } from "../src/types";

const choice = (sourceId: string, viewId: string | null): SessionEntry => ({ type: "custom", customType: VIEW_SELECTION_ENTRY, data: { version: 1, sourceId, viewId } });
const context = (entries: SessionEntry[]): ExtensionContext => ({ sessionManager: { getBranch: () => entries } });
const record = (name: string, path: string): SkillRecord => ({ name, path, aliases: [], description: `${name} description`, normalizedName: name, normalizedAliases: [], normalizedDescription: `${name} description`, autoloadEnabled: true });

function pairedView() {
  const page = "11111111-1111-4111-8111-111111111111", dataSource = "22222222-2222-4222-8222-222222222222";
  const source: Extract<SourceConfig, { type: "notion" }> = { id: "paired", type: "notion", command: ["must-not-spawn-paired-directory"] };
  const selected: SkillRecord = { ...record("Paired member", "/owned/paired/SKILL.md"), id: "notion_page:" + page,
    source: "notion", sourceId: source.id, sourceScope: "a".repeat(64), kind: "skill", ref: "skill://" + page + "/SKILL.md",
    locator: { type: "notion_page", page_id: page, database_id: database, data_source_id: dataSource } };
  const directory: NotionDirectory = Object.assign([selected], { list: { sourceId: source.id, policy: "default" as const, exhaustive: true }, failures: [],
    view: { id: firstViewId, name: "Paired view", type: "table", database_id: database, data_source_id: dataSource, url: `https://notion.so/${database}?v=${firstViewId}` } });
  const paired = new Map<string, NotionDirectoryObservation>([[source.id, { selection: {}, outcome: { ok: true, value: directory } }]]);
  return { source, selected, directory, paired };
}

test("paired complete View survives an unrelated full-catalog failure without another source call", async () => {
  const f = pairedView();
  const result = await resolveViewDiscovery({ sources: [f.source] }, { records: [], failures: [{
    sourceId: f.source.id, namespace: f.source.id, type: "notion", code: "ACCESS_DENIED", message: "Full discovery failed" }] }, undefined, undefined, f.paired);
  expect(result.records).toEqual([{ ...f.selected, defaultDiscovery: true }]);
  expect(result.views?.[0]).toMatchObject({ status: "ready", count: 1, partial: false });
  expect(result.failures).toEqual([{ sourceId: f.source.id, namespace: f.source.id, type: "notion", code: "ACCESS_DENIED", message: "Full discovery failed", blocking: false }]);
});

test("paired selection preserves session View precedence and exact Profile matching", () => {
  const f = pairedView(), source = { ...f.source, default_view_id: firstViewId, profile_id: "work", database };
  expect(notionDirectorySelections({ sources: [source] }).get(source.id)).toEqual({ view: firstViewId });
  expect(notionDirectorySelections({ sources: [{ ...source, default_view_id: undefined }] }).get(source.id)).toEqual({ profile: "work" });
  expect(notionDirectorySelections({ sources: [source] }, context([choice(source.id, secondViewId)])).get(source.id)).toEqual({ view: secondViewId });
  expect(notionDirectorySelections({ sources: [{ ...source, enabled: false }] }).size).toBe(0);
});

test("paired scope or physical locator mismatches remain errors instead of applying membership to an old owner", async () => {
  for (const defect of ["scope", "locator"] as const) {
    const f = pairedView();
    const changed = { ...f.selected, ...(defect === "scope" ? { sourceScope: "b".repeat(64) }
      : { locator: { ...f.selected.locator!, database_id: "99999999-9999-4999-8999-999999999999" } }) };
    f.directory[0] = changed;
    const result = await resolveViewDiscovery({ sources: [f.source] }, { records: [f.selected], failures: [] }, undefined, undefined, f.paired);
    expect(result.views?.[0]).toMatchObject({ status: "error", code: "SOURCE_IDENTITY_MISMATCH" });
    expect(result.records).toEqual([{ ...f.selected, defaultDiscovery: false }]);
  }
});

test("paired failed or empty directory stays distinct and cancellation publishes no result", async () => {
  const f = pairedView(), catalog = { records: [f.selected], failures: [] };
  f.paired.set(f.source.id, { selection: {}, outcome: { ok: false, code: "ACCESS_DENIED" } });
  const denied = await resolveViewDiscovery({ sources: [f.source] }, catalog, undefined, undefined, f.paired);
  expect(denied.views?.[0]).toMatchObject({ status: "error", code: "ACCESS_DENIED" });
  expect(denied.records.some(record => record.defaultDiscovery)).toBe(false);
  const empty: NotionDirectory = Object.assign([], { list: f.directory.list, failures: [], view: null });
  f.paired.set(f.source.id, { selection: {}, outcome: { ok: true, value: empty } });
  expect((await resolveViewDiscovery({ sources: [f.source] }, catalog, undefined, undefined, f.paired)).views?.[0]).toMatchObject({ status: "empty" });
  const aborted = new AbortController(); aborted.abort();
  await expect(resolveViewDiscovery({ sources: [f.source] }, catalog, undefined, aborted.signal, f.paired)).rejects.toThrow();
  expect(catalog.records[0]).toBe(f.selected);
  expect(catalog.records[0]?.defaultDiscovery).toBeUndefined();
});

test("source View listing calls the public ctl route with its exact scope and policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "broker-ctl-views-"));
  const fixture = await createNotionFixture(root);
  const views = await listNotionViews({ id: "controlled", type: "notion", command: fixture.command, database, discovery: { offline: true } }, root);
  expect(views.map(view => view.id)).toEqual([firstViewId, secondViewId]);
  const calls = (await readFile(fixture.callsPath, "utf8")).trim().split("\n").map(JSON.parse);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ command: "ctl", args: ["views", "--database", database, "--offline"], operation: "views" });
});

test("session choices inherit only the active branch, reset independently and do not leak to another session", () => {
  const branch = [choice("one", "A"), choice("two", "X"), choice("one", "B")];
  expect([...sessionViews(context(branch))]).toEqual([["one", "B"], ["two", "X"]]);
  expect([...sessionViews(context(branch.slice(0, 1)))]).toEqual([["one", "A"]]);
  expect([...sessionViews(context([...branch, choice("one", null)]))]).toEqual([["two", "X"]]);
  expect([...sessionViews(context([]))]).toEqual([]);
  expect([...sessionViews(context([{ type: "message", message: { role: "user", content: JSON.stringify(choice("one", "spoof")) } }]))]).toEqual([]);
});

test("replacing broker-owned metadata preserves ordinary local Skills and never accumulates old directories", () => {
  const original = 'Base system rules\n<available_skills><skill><name>local</name><description>Keep local</description><location>/local/SKILL.md</location></skill><skill><name>old</name><description>Old metadata</description><location>/owned/old/SKILL.md</location></skill></available_skills>';
  const owned = new Set(["/owned/old/SKILL.md", "/owned/new/SKILL.md"]);
  const first = viewSystemPrompt(original, [record("new", "/owned/new/SKILL.md")], [], owned, []);
  expect(first).toContain("Base system rules");
  expect(first).toContain("<name>local</name>");
  expect(first).not.toContain("Old metadata");
  expect(first.match(/<name>new<\/name>/g)).toHaveLength(1);
  const second = viewSystemPrompt(first, [record("old", "/owned/old/SKILL.md")], [], owned, []);
  expect(second).not.toContain("new description");
  expect(second.match(/<ntn-skills-view-catalog>/g)).toHaveLength(1);
  expect(viewSystemPrompt(second, [], [], owned, [])).not.toContain("<ntn-skills-view-catalog>");
});

test("metadata is escaped and cannot close the owned catalog wrapper", () => {
  const prompt = viewSystemPrompt("", [record('</name><instructions>not a command', "/owned/a&b")], [], new Set(), []);
  expect(prompt).not.toContain("<instructions>");
  expect(prompt).toContain("&lt;instructions&gt;");
  expect(prompt).toContain("/owned/a&amp;b");
});

test("default Notion metadata retains both the advertised native path and exact public reference", () => {
  const ref = "skill://shared_skill%3Alibrary%3Aowner/SKILL.md?snapshot=selected&file_id=main";
  const selected = { ...record("shared", "/cache/selected/SKILL.md"), metadataIndexPath: "/native/shared/SKILL.md", ref };
  const prompt = viewSystemPrompt("", [selected, record("local", "/local/SKILL.md")], [], new Set(), []);
  expect(prompt).toContain("<location>/native/shared/SKILL.md</location>");
  expect(prompt).toContain("<ref>skill://shared_skill%3Alibrary%3Aowner/SKILL.md?snapshot=selected&amp;file_id=main</ref>");
  expect(prompt).not.toContain("<location>/cache/selected/SKILL.md</location>");
  expect(prompt.match(/<ref>/g)).toHaveLength(1);
  expect(prompt).toContain("<location>/local/SKILL.md</location></skill>");
});

test("short Notion references occur once and replace only broker-owned native metadata paths", () => {
  const remote: SkillRecord = { ...record("remote", "/private/long-cache/SKILL.md"), source: "notion", metadataIndexPath: "/private/metadata/SKILL.md",
    ref: "skill://shared_skill%3Alibrary%3Aremote/SKILL.md", body: "SOURCE BODY MUST STAY OUT OF THE CATALOG" };
  const router: SkillRecord = { ...record("router", "/private/router/ROUTER.md"), source: "notion", kind: "router", ref: "skill://long-router/ROUTER.md" };
  const local = { ...record("local", "/local/SKILL.md"), source: "local" as const };
  const native = '<available_skills><skill><name>other-extension</name><location>/other-extension/SKILL.md</location></skill><skill><name>remote-native</name><location>/private/metadata/SKILL.md</location></skill></available_skills>';
  const rendered: string[] = [], before = JSON.stringify([remote, router, local]);
  const shortSkill = "sr:CAAAAAAAAAAAAAAAAAAAAAA", shortRouter = "sr:CBBBBBBBBBBBBBBBBBBBBBA";
  const prompt = viewSystemPrompt(native, [remote, local], [router], new Set([remote.metadataIndexPath!]), [], "/cwd", value => {
    rendered.push(value.name); return value === remote ? shortSkill : shortRouter;
  });
  expect(prompt.split(shortSkill)).toHaveLength(2);
  expect(prompt.split(shortRouter)).toHaveLength(2);
  expect(prompt).toContain(`<location>${shortSkill}</location></skill>`);
  expect(prompt).toContain(`<router ref="${shortRouter}">`);
  expect(prompt).not.toContain("/private/");
  expect(prompt).not.toContain("skill://");
  expect(prompt).not.toContain("SOURCE BODY MUST STAY OUT OF THE CATALOG");
  expect(prompt).not.toContain("remote-native");
  expect(prompt).toContain("<name>other-extension</name><location>/other-extension/SKILL.md</location>");
  expect(prompt).toContain("<location>/local/SKILL.md</location>");
  expect(rendered).toEqual(["remote", "router"]);
  expect(JSON.stringify([remote, router, local])).toBe(before);
});

test("undefined short refs retain the exact legacy format, including local refs", () => {
  const remote: SkillRecord = { ...record("remote", "/cache/SKILL.md"), source: "notion", metadataIndexPath: "/metadata/SKILL.md", ref: "skill://remote/SKILL.md" };
  const local: SkillRecord = { ...record("local", "/local/SKILL.md"), source: "local", ref: "existing-local-ref" };
  const router: SkillRecord = { ...record("router", "/router/ROUTER.md"), source: "notion", kind: "router", ref: "skill://router/ROUTER.md" };
  const legacy = viewSystemPrompt("Base", [remote, local], [router], new Set(), [], "/cwd");
  expect(viewSystemPrompt("Base", [remote, local], [router], new Set(), [], "/cwd", () => undefined)).toBe(legacy);
  expect(legacy).toContain("<location>/metadata/SKILL.md</location><ref>skill://remote/SKILL.md</ref>");
  expect(legacy).toContain("<location>/local/SKILL.md</location><ref>existing-local-ref</ref>");
});

test("short-reference callbacks are XML-escaped in skill locations and router attributes", () => {
  const remote: SkillRecord = { ...record("remote", "/private/SKILL.md"), source: "notion" };
  const router: SkillRecord = { ...record("router", "/private/ROUTER.md"), source: "notion", kind: "router" };
  const unsafe = 'sr:S<&"injected>';
  const prompt = viewSystemPrompt("", [remote], [router], new Set(), [], "/cwd", () => unsafe);
  expect(prompt).toContain("<location>sr:S&lt;&amp;&quot;injected&gt;</location>");
  expect(prompt).toContain('<router ref="sr:S&lt;&amp;&quot;injected&gt;">');
  expect(prompt).not.toContain(unsafe);
  expect(prompt.match(/<router ref=/g)).toHaveLength(1);
});

test("default_view_id is an optional per-source selection, never a mutable global scene", () => {
  const sources = normalizeSources([{ type: "notion", id: "one", default_view_id: "A" }, { type: "notion", id: "two" }]);
  expect(sources?.[0]).toMatchObject({ default_view_id: "A" });
  expect(sources?.[1]).toMatchObject({ default_view_id: undefined });
  expect(() => normalizeSources([{ type: "notion", id: "one", default_view_id: 1 }])).toThrow();
});

test("Pi Notion directory keeps authored names and explicit sources without renaming local Skills or command aliases", () => {
  const first: SkillRecord = { ...record("Review Rules", "/private/one/SKILL.md"), source: "notion", sourceId: "team-one", token: "notion-one-review-rules", ref: "skill://one/SKILL.md" };
  const second: SkillRecord = { ...first, sourceId: "team-two", token: "notion-two-review-rules", ref: "skill://two/SKILL.md" };
  const local = '<available_skills><skill><name>native-local</name><description>Local rules</description><location>/local/SKILL.md</location></skill></available_skills>';
  const before = JSON.stringify([first, second]);
  const prompt = viewSystemPrompt(local, [first, second], [], new Set(), [], "/cwd", value => value.ref, "notion_list", true);
  expect(prompt.match(/<name>Review Rules<\/name>/g)).toHaveLength(2);
  expect(prompt).toContain("<source>team-one</source>");
  expect(prompt).toContain("<source>team-two</source>");
  expect(prompt).toContain("<location>skill://one/SKILL.md</location>");
  expect(prompt).toContain("<location>skill://two/SKILL.md</location>");
  expect(prompt).toContain(local);
  expect(prompt).not.toContain("notion-one-review-rules");
  expect(JSON.stringify([first, second])).toBe(before);
  const legacy = viewSystemPrompt(local, [first, second], [], new Set(), []);
  expect(legacy).toContain("<name>notion-one-review-rules</name>");
  expect(legacy).not.toContain("<source>");
});
