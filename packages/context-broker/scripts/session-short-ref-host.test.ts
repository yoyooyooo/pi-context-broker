import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createSessionShortRefHost, isSessionShortRefInput, matchesShortRefSource, assertShortRefSource, assertShortRefSnapshot } from "../src/session-short-ref-host";
import { SESSION_SHORT_REF_ENTRY } from "../src/session-short-ref";
import type { ContentRecord, ExtensionAPI, ExtensionContext, SessionEntry, SkillRecord } from "../src/types";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (id: number) => "00000000-0000-4000-8000-" + String(id).padStart(12, "0");
const scope = hash("source A"), foreignScope = hash("source B");
function code(action: () => unknown, expected: string) { expect(action).toThrow(expect.objectContaining({ code: expected })); }
function fixture(version = "one") {
  const id = "shared_skill:bridge:owner", base = "skill://" + encodeURIComponent(id) + "/", body = "instructions " + version;
  const snapshot = "s_" + hash("snapshot " + version), resource = "resources/guide.md";
  const record: ContentRecord = { id, kind: "skill", name: "Owner", alias: "owner", description: "metadata", default_context: false, enabled: true,
    entrypoint: "SKILL.md", ref: base + "SKILL.md", locator: { type: "shared_skill", library_id: "bridge", skill_id: "owner", page_id: uuid(1), database_id: uuid(10), data_source_id: uuid(11) } };
  const files = [{ path: "SKILL.md", bytes: Buffer.byteLength(body), sha256: hash(body), ref: base + "SKILL.md?snapshot=" + snapshot + "&file_id=main" },
    { path: resource, bytes: 8, sha256: hash("resource"), ref: base + resource + "?snapshot=" + snapshot + "&file_id=guide" }];
  const metadata: SkillRecord = { ...record, source: "notion", sourceId: "configured-source", sourceScope: scope, path: "/private/metadata/SKILL.md",
    aliases: [], normalizedAliases: [], normalizedName: "owner", normalizedDescription: "metadata", autoloadEnabled: false };
  const selected: SkillRecord = { ...metadata, body, path: "/private/cache/SKILL.md", snapshotId: snapshot, versionId: hash("version " + version),
    preparationBinding: { record, scope, snapshot_id: snapshot, version_id: hash("version " + version), body_sha256: hash(body), ref: files[0]!.ref },
    fileBindings: [{ file_id: "main", path: "SKILL.md", page_id: uuid(1) }, { file_id: "guide", path: resource, page_id: uuid(2) }],
    entryManifest: { version: 1, root: "/private/cache", receipt: "/private/receipt", manifest_id: hash("verified fixture manifest"),
      files, manifest_complete: true, local_files_ready: false, materialized_paths: ["SKILL.md"] } };
  return { record, metadata, selected, files };
}
function session() {
  const state = { branch: [] as SessionEntry[], id: "session-one", file: "/sessions/one.jsonl", writes: 0, branchReads: 0, allEntriesCalls: 0, subscriptions: 0 };
  const api: ExtensionAPI = { on() { state.subscriptions++; }, appendEntry(customType, data) {
    state.writes++; state.branch.push({ type: "custom", customType, data });
  } };
  const ctx: ExtensionContext = { sessionManager: {
    getBranch() { state.branchReads++; return state.branch; }, getSessionId: () => state.id, getSessionFile: () => state.file,
    getEntries() { state.allEntriesCalls++; throw new Error("All entries must never supply short refs"); },
  } };
  return { state, api, ctx, host: createSessionShortRefHost(api) };
}
function directoryRecords(count: number): SkillRecord[] {
  const f = fixture();
  return Array.from({ length: count }, (_, index): SkillRecord => {
    const skill = "member-" + index, id = "shared_skill:bridge:" + skill;
    return { ...f.metadata, id, ref: "skill://" + encodeURIComponent(id) + "/SKILL.md",
      locator: { type: "shared_skill", library_id: "bridge", skill_id: skill, page_id: uuid(index + 100), database_id: uuid(10), data_source_id: uuid(11) } };
  });
}

test("candidate batch publishes 74 directory refs with two cold branch reads and one per warm projection", () => {
  const h = session(), records = directoryRecords(74);
  const refs = h.host.candidates(h.ctx, records);
  expect(refs).toHaveLength(74);
  expect(new Set(refs).size).toBe(74);
  expect(h.state.writes).toBe(74);
  expect(h.state.branchReads).toBe(2);
  const saved = JSON.stringify(h.state.branch), reads = h.state.branchReads;
  for (let index = 0; index < 3; index++) {
    expect(h.host.candidates(h.ctx, records.map(record => ({ ...record, description: "Updated display metadata" })))).toEqual(refs);
  }
  expect(h.state.branchReads - reads).toBe(3);
  expect(h.state.writes).toBe(74);
  expect(JSON.stringify(h.state.branch)).toBe(saved);
  expect(h.state.allEntriesCalls).toBe(0);
});

test("candidate batch validates every input before appending any binding", () => {
  const h = session(), records = directoryRecords(2);
  code(() => h.host.candidates(h.ctx, [records[0]!, { ...records[1]!, sourceScope: "invalid" }]), "SHORT_REF_INVALID");
  expect(h.state.writes).toBe(0);
  expect(h.state.branch).toEqual([]);
});

test("candidate batch checks every persisted ref even when the last append succeeds", () => {
  const h = session(), records = directoryRecords(2), append = h.api.appendEntry!;
  let calls = 0;
  h.api.appendEntry = (kind, data) => { if (++calls === 2) append(kind, data); };
  code(() => h.host.candidates(h.ctx, records), "SHORT_REF_PERSIST_FAILED");
  expect(calls).toBe(2);
  expect(h.state.branch).toHaveLength(1);
});

test("candidate batch follows same-session rewind and independent external appends without losing fixed pins", () => {
  const h = session(), f = fixture(), records = directoryRecords(2);
  const old = h.host.selected(h.ctx, f.selected), original = structuredClone(h.state.branch);
  const refs = h.host.candidates(h.ctx, records);
  const complete = JSON.parse(JSON.stringify(h.state.branch));
  h.state.branch = structuredClone(original);
  code(() => h.host.resolve(h.ctx, refs[0]!), "SHORT_REF_UNKNOWN");
  const replacement = h.host.candidates(h.ctx, records);
  expect(replacement[0]).not.toBe(refs[0]);
  expect(h.host.resolve(h.ctx, old).canonicalRef).toBe(f.files[0]!.ref);
  h.state.branch = complete;
  const independent = createSessionShortRefHost(h.api), foreign = { ...records[0]!, sourceScope: foreignScope };
  const foreignRef = independent.candidate(h.ctx, foreign), writes = h.state.writes;
  expect(h.host.candidates(h.ctx, [records[0]!, foreign])).toEqual([refs[0], foreignRef]);
  expect(h.state.writes).toBe(writes);
  expect(h.host.resolve(h.ctx, old).canonicalRef).toBe(f.files[0]!.ref);
});

test("candidate batch preserves missing-append, no-op, partial-failure and branch-change rejection", () => {
  const records = directoryRecords(2);
  const missing = session();
  code(() => createSessionShortRefHost({ on() {} }).candidates(missing.ctx, records), "SHORT_REF_SESSION_UNAVAILABLE");
  code(() => createSessionShortRefHost({ on() {}, appendEntry() {} }).candidates(missing.ctx, records), "SHORT_REF_PERSIST_FAILED");
  expect(missing.state.branch).toEqual([]);
  const failed = session(), append = failed.api.appendEntry!;
  failed.api.appendEntry = (kind, data) => { if (failed.state.writes === 1) throw new Error("Private append error"); append(kind, data); };
  code(() => failed.host.candidates(failed.ctx, records), "SHORT_REF_PERSIST_FAILED");
  expect(failed.state.branch).toHaveLength(1);
  const switched = session(), changedAppend = switched.api.appendEntry!;
  switched.api.appendEntry = (kind, data) => { changedAppend(kind, data); switched.state.id = "changed"; };
  code(() => switched.host.candidates(switched.ctx, records), "SHORT_REF_SESSION_CHANGED");
  const rewound = session(), retained = rewound.host.selected(rewound.ctx, fixture().selected), rewindAppend = rewound.api.appendEntry!;
  rewound.api.appendEntry = (kind, data) => { rewound.state.branch = []; rewindAppend(kind, data); };
  code(() => rewound.host.candidates(rewound.ctx, records), "SHORT_REF_SESSION_CHANGED");
  code(() => rewound.host.resolve(rewound.ctx, retained), "SHORT_REF_UNKNOWN");
});

test("directory, prepared main and resource display persist before returning and repeat without growth", () => {
  const h = session(), f = fixture();
  const candidate = h.host.candidate(h.ctx, f.metadata);
  expect(h.state.writes).toBe(1);
  expect(h.state.branch[0]?.customType).toBe(SESSION_SHORT_REF_ENTRY);
  expect(h.host.candidate(h.ctx, f.metadata)).toBe(candidate);
  const main = h.host.selected(h.ctx, f.selected), resource = h.host.resource(h.ctx, f.selected, f.files[1]!.ref);
  expect(h.state.writes).toBe(3);
  expect(h.host.selected(h.ctx, f.selected)).toBe(main);
  expect(h.host.resource(h.ctx, f.selected, f.files[1]!.ref)).toBe(resource);
  expect(h.host.resource(h.ctx, f.selected, f.files[0]!.ref)).toBe(main);
  expect(h.state.writes).toBe(3);
  expect(h.host.resolve(h.ctx, candidate).kind).toBe("candidate");
  expect(h.host.resolve(h.ctx, main).canonicalRef).toBe(f.files[0]!.ref);
  expect(h.host.resolve(h.ctx, resource).canonicalRef).toBe(f.files[1]!.ref);
  expect(h.state.allEntriesCalls).toBe(0);
  expect(h.state.subscriptions).toBe(0);
});

test("a fresh bridge restores JSON entries and follows the current branch after fork, rewind and session switch", () => {
  const h = session(), f = fixture(), ancestor = h.host.candidate(h.ctx, f.metadata);
  const common = structuredClone(h.state.branch), left = h.host.selected(h.ctx, f.selected);
  const leftBranch = JSON.parse(JSON.stringify(h.state.branch));
  h.state.branch = structuredClone(common);
  const right = h.host.selected(h.ctx, fixture("two").selected);
  code(() => h.host.resolve(h.ctx, left), "SHORT_REF_UNKNOWN");
  h.state.branch = leftBranch;
  const restarted = createSessionShortRefHost(h.api);
  expect(restarted.resolve(h.ctx, left).canonicalRef).toBe(f.files[0]!.ref);
  expect(restarted.resolve(h.ctx, ancestor).kind).toBe("candidate");
  code(() => restarted.resolve(h.ctx, right), "SHORT_REF_UNKNOWN");
  h.state.branch = structuredClone(common);
  code(() => restarted.resolve(h.ctx, left), "SHORT_REF_UNKNOWN");
  h.state.id = "new-session"; h.state.file = "/sessions/new.jsonl"; h.state.branch = [];
  code(() => restarted.resolve(h.ctx, ancestor), "SHORT_REF_UNKNOWN");
  expect(h.state.allEntriesCalls).toBe(0);
});

test("URI equality cannot replace exact scope and physical source assertions", () => {
  const h = session(), f = fixture(), ref = h.host.candidate(h.ctx, f.metadata), resolved = h.host.resolve(h.ctx, ref);
  expect(matchesShortRefSource(resolved.assertion, f.metadata)).toBe(true);
  assertShortRefSource(resolved, f.metadata);
  const wrongScope = { ...f.metadata, sourceScope: foreignScope };
  const wrongDatabase = { ...f.metadata, locator: { ...f.record.locator, database_id: uuid(99) } };
  for (const record of [wrongScope, wrongDatabase, { ...f.metadata, sourceId: undefined }, { ...f.metadata, id: "different" }, { ...f.metadata, ref: "skill://another/SKILL.md" }]) {
    expect(record.ref).toBeDefined();
    expect(matchesShortRefSource(resolved.assertion, record)).toBe(false);
  }
  code(() => assertShortRefSource(resolved, wrongScope), "SHORT_REF_SCOPE_MISMATCH");
  code(() => assertShortRefSource(resolved, wrongDatabase), "SHORT_REF_OWNER_MISMATCH");
  expect(resolved.assertion).toMatchObject({ scope, id: f.record.id, locator: f.record.locator });
});

test("fixed references check the returned pin and hash before a prepare/read result is exposed", () => {
  const h = session(), f = fixture(), main = h.host.selected(h.ctx, f.selected), resolved = h.host.resolve(h.ctx, main);
  assertShortRefSnapshot(resolved, f.selected);
  code(() => assertShortRefSnapshot(resolved, fixture("two").selected), "SHORT_REF_OWNER_MISMATCH");
  code(() => assertShortRefSnapshot(resolved, { ...f.selected, preparationBinding: { ...f.selected.preparationBinding!, body_sha256: hash("wrong") } }), "SHORT_REF_OWNER_MISMATCH");
  code(() => assertShortRefSnapshot(resolved, { ...f.selected, preparationBinding: undefined }), "SHORT_REF_OWNER_MISMATCH");
  const second = h.host.selected(h.ctx, fixture("two").selected);
  expect(second).not.toBe(main);
  expect(h.host.resolve(h.ctx, main).canonicalRef).toBe(f.files[0]!.ref);
});

test("resource result assertions reject changed bytes, renamed same-pin paths and another File ID", () => {
  const h = session(), f = fixture(), ref = h.host.resource(h.ctx, f.selected, f.files[1]!.ref), resolved = h.host.resolve(h.ctx, ref);
  expect(h.state.writes).toBe(2);
  assertShortRefSnapshot(resolved, f.selected);
  for (const changed of [
    { ...f.files[1]!, sha256: hash("changed") }, { ...f.files[1]!, bytes: 999 },
    { ...f.files[1]!, ref: f.files[1]!.ref.replace("file_id=guide", "file_id=another") },
  ]) {
    const snapshot = { ...f.selected, entryManifest: { ...f.selected.entryManifest!, files: [f.files[0]!, changed] } };
    code(() => assertShortRefSnapshot(resolved, snapshot), "SHORT_REF_OWNER_MISMATCH");
  }
  const moved = { ...f.selected, fileBindings: f.selected.fileBindings!.map(file => file.file_id === "guide" ? { ...file, path: "moved.md" } : file) };
  code(() => assertShortRefSnapshot(resolved, moved), "SHORT_REF_OWNER_MISMATCH");
});

test("invalid resource display writes neither a resource nor its new owner", () => {
  const h = session(), f = fixture();
  code(() => h.host.resource(h.ctx, f.selected, f.files[1]!.ref.replace("file_id=guide", "file_id=missing")), "SHORT_REF_OWNER_MISMATCH");
  expect(h.state.writes).toBe(0);
  expect(h.state.branch).toEqual([]);
  const malformed = { ...f.selected, sourceScope: foreignScope };
  code(() => h.host.selected(h.ctx, malformed), "SHORT_REF_SCOPE_MISMATCH");
  expect(h.state.writes).toBe(0);
});

test("missing branch APIs never borrow all entries or create process-only references", () => {
  const h = session(), f = fixture(), noBranch: ExtensionContext = { sessionManager: { getEntries: () => h.state.branch } };
  expect(h.host.canBind(noBranch)).toBe(false);
  code(() => h.host.candidate(noBranch, f.metadata), "SHORT_REF_SESSION_UNAVAILABLE");
  const readOnly = createSessionShortRefHost({ on() {} });
  expect(readOnly.canBind(h.ctx)).toBe(false);
  code(() => readOnly.candidate(h.ctx, f.metadata), "SHORT_REF_SESSION_UNAVAILABLE");
  expect(h.state.writes).toBe(0);
});

test("a void/no-op append cannot advertise an unpersisted handle", () => {
  const h = session(), f = fixture(), api: ExtensionAPI = { on() {}, appendEntry() {} };
  code(() => createSessionShortRefHost(api).candidate(h.ctx, f.metadata), "SHORT_REF_PERSIST_FAILED");
  expect(h.state.branch).toEqual([]);
});

test("append failures retain valid earlier entries and do not expose a partial resource plan", () => {
  const h = session(), f = fixture();
  const append = h.api.appendEntry!;
  h.api.appendEntry = (kind, data) => {
    if (h.state.writes === 1) throw new Error("Cannot write /secret/session/path");
    append(kind, data);
  };
  code(() => h.host.resource(h.ctx, f.selected, f.files[1]!.ref), "SHORT_REF_PERSIST_FAILED");
  expect(h.state.branch).toHaveLength(1);
  h.api.appendEntry = append;
  const resource = h.host.resource(h.ctx, f.selected, f.files[1]!.ref);
  expect(h.state.branch).toHaveLength(2);
  expect(h.host.resolve(h.ctx, resource).kind).toBe("resource");
});

test("a synchronous session change during append fails before display", () => {
  const h = session(), f = fixture(), append = h.api.appendEntry!;
  h.api.appendEntry = (kind, data) => { append(kind, data); h.state.id = "changed"; };
  code(() => h.host.candidate(h.ctx, f.metadata), "SHORT_REF_SESSION_CHANGED");
});

test("display does not edit source bodies or graph locks and registers no lifecycle handlers", () => {
  const h = session(), f = fixture(), graph = { version: 1, opaque: "existing graph proof" };
  h.state.branch.push({ type: "custom", customType: "context-broker-selected-graph", data: graph });
  const source = JSON.stringify(f.selected);
  h.host.resource(h.ctx, f.selected, f.files[1]!.ref);
  expect(JSON.stringify(f.selected)).toBe(source);
  expect(h.state.branch[0]?.data).toBe(graph);
  expect(h.state.subscriptions).toBe(0);
  expect(f.selected.entryManifest?.local_files_ready).toBe(false);
});

test("the reserved prefix catches malformed input without claiming ordinary canonical or file paths", () => {
  const h = session();
  for (const value of ["sr:", "sr:S3", "sr:Snot-a-real-token?other=1"]) {
    expect(isSessionShortRefInput(value)).toBe(true);
    code(() => h.host.resolve(h.ctx, value), "SHORT_REF_INVALID");
  }
  for (const value of ["skill://owner/SKILL.md", "/tmp/SKILL.md", "S3", 123, null]) expect(isSessionShortRefInput(value)).toBe(false);
});

test("host export is branch-local, fixed-version only and does not write or leak session handles", () => {
  const h = session(), f = fixture(), candidate = h.host.candidate(h.ctx, f.metadata);
  const ancestor = structuredClone(h.state.branch), main = h.host.selected(h.ctx, f.selected), resource = h.host.resource(h.ctx, f.selected, f.files[1]!.ref);
  const writes = h.state.writes;
  const exportedMain = h.host.export(h.ctx, main), exportedResource = h.host.export(h.ctx, resource);
  expect(exportedMain).toMatchObject({ version: 1, kind: "fixed_skill_reference", ref: f.files[0]!.ref,
    owner: { snapshot_id: f.selected.snapshotId, version_id: f.selected.versionId, identity: { scope, locator: f.record.locator } } });
  expect(exportedResource).toMatchObject({ ref: f.files[1]!.ref, file: { file_id: "guide", path: "resources/guide.md", sha256: f.files[1]!.sha256, bytes: 8 } });
  expect(JSON.stringify(exportedResource)).not.toContain("sr:");
  expect(JSON.stringify(exportedResource)).not.toContain("/private/");
  code(() => h.host.export(h.ctx, candidate), "SHORT_REF_NOT_PINNED");
  expect(h.state.writes).toBe(writes);
  h.state.branch = ancestor;
  code(() => h.host.export(h.ctx, main), "SHORT_REF_UNKNOWN");
  code(() => h.host.export(h.ctx, resource), "SHORT_REF_UNKNOWN");
});
