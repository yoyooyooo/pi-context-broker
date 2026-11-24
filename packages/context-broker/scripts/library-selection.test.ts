import { expect, test } from "bun:test";
import { createLibraryCommand, createLibrarySelection, inheritLibraryContext, LIBRARY_SELECTION_ENTRY, sessionLibrary } from "../src/library-selection";
import type { SharedLibrary } from "../src/notion-sdk";
import type { ConfigFile, ExtensionAPI, ExtensionContext, SessionEntry } from "../src/types";

const uuid = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const a = uuid(1), b = uuid(2);
const descriptor = (root: string): SharedLibrary => {
  const table = (n: number) => ({ database_id: uuid(n), data_source_id: uuid(n + 1), property_ids: {} });
  return { version: 2, library_id: root, operation_id: "init", skills: table(10), files: table(20), records: table(30), sources: table(40) };
};
const config: ConfigFile = { sources: [{ type: "notion", id: "a", library: a }, { type: "notion", id: "b", library: b }] };
function harness(selected = a) {
  let branch: SessionEntry[] = [], session = "session";
  const events = new Map<string, unknown[]>();
  const calls: Array<string | undefined> = [], notices: string[] = [];
  let resolve = async (root: string | undefined) => descriptor(root ?? selected);
  const owner = createLibrarySelection(config, async options => { calls.push(options.library); return resolve(options.library); }, async options => options.library ?? selected);
  const ctx: ExtensionContext = { cwd: "/test", sessionManager: { getBranch: () => branch, getSessionId: () => session }, ui: { notify: message => notices.push(message) } };
  const api: ExtensionAPI = { on(name, handler) { events.set(name, [...events.get(name) ?? [], handler]); },
    appendEntry(customType, data) { branch = [...branch, { id: String(branch.length + 1), type: "custom", customType, data }]; } };
  const refreshed: ExtensionContext[] = [];
  const command = createLibraryCommand(api, owner, async ctx => { refreshed.push(ctx); });
  return { ctx, owner, command, calls, notices, refreshed, get branch() { return branch; },
    branchTo(value: SessionEntry[]) { branch = value; }, resolver(value: typeof resolve) { resolve = value; },
    async switchSession() { for (const handler of events.get("session_before_switch") ?? []) { if (typeof handler !== "function") throw new Error("Invalid handler"); await handler({}, ctx); } session = "other"; branch = []; } };
}

test("SDK default supplies the root; an empty Library needs no discovered Skill", async () => {
  const h = harness();
  const selected = await h.owner.selected(h.ctx);
  expect(h.calls).toEqual([a]);
  expect(selected?.source).toMatchObject({ id: "a", library: a });
  expect(selected?.library.skills.database_id).not.toBe(selected?.library.library_id);
});

test("accepted A context and publication identity survive a subsequent B selection", async () => {
  const h = harness(), accepted = h.owner.capture(h.ctx);
  await h.owner.selected(accepted);
  await h.command("library " + b, h.ctx);
  expect((await h.owner.selected(h.ctx))?.source.id).toBe("b");
  expect((await h.owner.selected(inheritLibraryContext(h.ctx, accepted)))?.source.id).toBe("a");
  expect(h.owner.isCurrent(accepted)).toBe(false);
  expect(h.owner.isCurrent(h.owner.capture(h.ctx))).toBe(true);
});

test("requested B is visible before verification and failure blocks defaults instead of falling back to A", async () => {
  const h = harness(), accepted = h.owner.capture(h.ctx);
  await h.owner.selected(accepted);
  const gate = Promise.withResolvers<SharedLibrary>();
  h.resolver(root => root === b ? gate.promise : Promise.resolve(descriptor(a)));
  const pending = h.command("library " + b, h.ctx);
  expect(sessionLibrary(h.ctx)).toMatchObject({ library: b, status: "requested" });
  gate.reject(Object.assign(new Error("denied"), { code: "ACCESS_DENIED" }));
  await pending;
  expect(sessionLibrary(h.ctx)).toMatchObject({ library: b, status: "blocked", code: "ACCESS_DENIED" });
  await expect(h.owner.selected(h.ctx)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect((await h.owner.selected(accepted))?.library.library_id).toBe(a);
  await h.command("library " + a, h.ctx);
  expect((await h.owner.selected(h.ctx))?.library.library_id).toBe(a);
});

test("fork, rewind, resume and reset follow only active branch Library entries", async () => {
  const h = harness();
  await h.command("library " + a, h.ctx); const parent = h.branch;
  await h.command("library " + b, h.ctx); const child = h.branch;
  h.branchTo(parent); expect((await h.owner.selected(h.ctx))?.library.library_id).toBe(a);
  h.branchTo(child); expect((await h.owner.selected(h.ctx))?.library.library_id).toBe(b);
  await h.command("library default", h.ctx); expect((await h.owner.selected(h.ctx))?.library.library_id).toBe(a);
  await h.switchSession(); expect(sessionLibrary(h.ctx)).toEqual({ library: null, status: "ready" });
});

test("late B verification cannot append or publish into a different session", async () => {
  const h = harness(), gate = Promise.withResolvers<SharedLibrary>();
  h.resolver(() => gate.promise);
  const pending = h.command("library " + b, h.ctx);
  await h.switchSession(); gate.resolve(descriptor(b)); await pending;
  expect(h.branch).toEqual([]); expect(h.refreshed).toEqual([]);
});

test("a root without an enabled Source, duplicate root Sources and missing default fail closed", async () => {
  for (const sources of [[{ type: "notion" as const, id: "a", library: a }],
    [{ type: "notion" as const, id: "a", library: b }, { type: "notion" as const, id: "same", library: b }]]) {
    const owner = createLibrarySelection({ sources }, async () => descriptor(b), async () => b);
    await expect(owner.selected()).rejects.toMatchObject({ code: sources.length === 1 ? "LIBRARY_SOURCE_UNAVAILABLE" : "LIBRARY_SOURCE_AMBIGUOUS" });
  }
  const missing = createLibrarySelection(config, async () => descriptor(a), async () => { throw Object.assign(new Error("no default"), { code: "LIBRARY_CONTEXT_REQUIRED" }); });
  await expect(missing.selected()).rejects.toMatchObject({ code: "LIBRARY_CONTEXT_REQUIRED" });
});

test("implicit Source binds the one SDK default, and exact foreign routing leaves it unchanged", async () => {
  const owner = createLibrarySelection({ sources: [{ type: "notion", id: "default" }, { type: "notion", id: "b", library: b }] },
    async options => descriptor(options.library ?? a), async options => options.library ?? a);
  expect((await owner.selected())?.source).toMatchObject({ id: "default", library: a });
  expect(await owner.route(b, {})).toMatchObject([{ id: "b", library: b }]);
  expect((await owner.selected())?.library.library_id).toBe(a);
  expect(LIBRARY_SELECTION_ENTRY).toBe("ntn-skills-library-selection");
});

test("a malformed latest selection blocks the branch until an explicit valid replacement", async () => {
  const h = harness();
  h.branchTo([{ id: "bad", type: "custom", customType: LIBRARY_SELECTION_ENTRY, data: { version: 1, library: "not-a-root", status: "ready" } }]);
  expect(() => h.owner.capture(h.ctx)).toThrow("LIBRARY_SELECTION_INVALID");
  await h.command("library " + b, h.ctx);
  expect((await h.owner.selected(h.ctx))?.library.library_id).toBe(b);
});

test("every input rereads local default while root verification and metadata keys reuse the same identity", async () => {
  let current = a, selections = 0;
  const verified: string[] = [];
  const owner = createLibrarySelection({ sources: [{ type: "notion", id: "implicit" }] },
    async options => { verified.push(options.library!); return descriptor(options.library!); },
    async options => { selections++; return options.library ?? current; });
  const first = owner.accept({ cwd: "/test" });
  expect((await owner.selected(first))?.library.library_id).toBe(a);
  const same = owner.accept({ cwd: "/test" });
  await owner.selected(same);
  expect(owner.key(same)).toBe(owner.key(first));
  expect(verified).toEqual([a]);
  current = b;
  const second = owner.accept({ cwd: "/test" });
  expect((await owner.selected(second))?.library.library_id).toBe(b);
  expect(selections).toBe(3); expect(verified).toEqual([a, b]);
  expect(owner.isCurrent(first)).toBe(false);
  expect((await owner.selected(first))?.library.library_id).toBe(a);
  expect(await owner.route(a, first)).toMatchObject([{ id: "implicit", library: a }]);
  await expect(owner.route(a, second)).rejects.toMatchObject({ code: "LIBRARY_SOURCE_UNAVAILABLE" });
});
