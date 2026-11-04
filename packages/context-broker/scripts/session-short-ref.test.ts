import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  SESSION_SHORT_REF_ENTRY, bindCandidate, bindCandidates, bindSelected, bindResource, reduceSessionShortRefs,
  resolveSessionShortRef, exportSessionShortRef,
  type SessionShortRefEvent, type SessionShortRefState, type ShortRefBindingPlan,
} from "../src/session-short-ref";
import { nativeResourcePath, parseNativeReference } from "../src/native-reference";
import { sharedSkillId } from "../src/shared-skill-identity";
import type { PreparationBinding } from "../src/prepare-protocol";
import type { ContentRecord, SessionEntry, SkillRecord } from "../src/types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const page = (last: string) => "00000000-0000-4000-8000-" + last.padStart(12, "0");
const scope = hash("authorized account A"), otherScope = hash("authorized account B");
const empty = () => reduceSessionShortRefs([]);
const entry = (data: unknown): SessionEntry => ({ type: "custom", customType: SESSION_SHORT_REF_ENTRY, data });
function code(action: () => unknown, expected: string) {
  expect(action).toThrow(expect.objectContaining({ code: expected }));
}
function event(plan: ShortRefBindingPlan): SessionShortRefEvent {
  if (!plan.event) throw new Error("Expected a new binding in this test");
  return plan.event;
}
function fixture(options: { version?: string; library?: string; skill?: string; resource?: string; fileId?: boolean; scope?: string } = {}) {
  const version = options.version ?? "one", resource = options.resource ?? "references/guide.md";
  const library = options.library ?? "lib:team", skill = options.skill ?? "skill:owner";
  const id = sharedSkillId(library, skill)!;
  const base = "skill://" + encodeURIComponent(id) + "/", selectedScope = options.scope ?? scope;
  const record: ContentRecord = { id, kind: "skill", name: "Same display name", alias: "owner", description: "Catalog metadata",
    default_context: false, enabled: true, entrypoint: "SKILL.md", ref: base + "SKILL.md",
    locator: { type: "shared_skill", page_id: page("1"), database_id: page("10"), data_source_id: page("11"),
      library_id: library, skill_id: skill } };
  const snapshot_id = "s_" + hash("snapshot " + version), version_id = hash("version " + version);
  const body = "---\nname: owner\n---\nExact instructions " + version + ".\n";
  const bytes = new Map([["SKILL.md", Buffer.from(body)], [resource, Buffer.from("Exact resource bytes.\n")]]);
  const files = [...bytes].map(([path, value]) => ({ path, bytes: value.length, sha256: hash(value),
    ref: base + path + "?snapshot=" + snapshot_id + (path === "SKILL.md" ? "&file_id=main" : options.fileId === false ? "" : "&file_id=guide") }));
  const binding: PreparationBinding = { record, scope: selectedScope, snapshot_id, version_id, body_sha256: hash(body), ref: files[0]!.ref };
  const snapshot: SkillRecord = { ...record, source: "notion", sourceId: "configured-source", sourceScope: selectedScope,
    path: "/machine-private/cache/scopes/long/records/long/snapshots/long/SKILL.md", body,
    aliases: [], normalizedAliases: [], normalizedName: "owner", normalizedDescription: "Catalog metadata", autoloadEnabled: false,
    snapshotId: snapshot_id, versionId: version_id, preparationBinding: binding,
    fileBindings: [{ path: "SKILL.md", file_id: "main", page_id: page("1") },
      ...(options.fileId === false ? [] : [{ path: resource, file_id: "guide", page_id: page("2") }])],
    entryManifest: { version: 1, root: "/machine-private/tree", receipt: "/machine-private/receipt", manifest_id: hash("verified fixture manifest"),
      files, manifest_complete: true, local_files_ready: false, materialized_paths: ["SKILL.md"] } };
  return { record, binding, snapshot, files, resourcePath: resource, bytes };
}
function selectedResource(f = fixture(), state: SessionShortRefState = empty()) {
  const selected = bindSelected(state, f.binding);
  const resource = bindResource(selected.state, selected.ref, f.snapshot, f.files[1]!.ref);
  return { ...f, selected, resource, state: resource.state };
}

test("candidate batches reuse duplicate identities, preserve order and separate scope and library", () => {
  const initial = empty(), f = fixture();
  const inputs = [{ record: f.record, scope }, { record: f.record, scope: otherScope },
    { record: fixture({ library: "another-library" }).record, scope },
    { record: { ...f.record, name: "Renamed display", description: "Changed display" }, scope }];
  const planned = bindCandidates(initial, inputs);
  expect(initial.bindings.size).toBe(0);
  expect(planned.refs).toHaveLength(4);
  expect(planned.events).toHaveLength(3);
  expect(planned.refs[0]).toBe(planned.refs[3]);
  expect(new Set(planned.refs).size).toBe(3);
  const replayed = reduceSessionShortRefs(planned.events.map(entry));
  expect([...replayed.bindings]).toEqual([...planned.state.bindings]);
  const repeated = bindCandidates(replayed, [...inputs].reverse());
  expect(repeated.refs).toEqual([...planned.refs].reverse());
  expect(repeated.events).toEqual([]);
  expect(repeated.state).toBe(replayed);
});

test("a warm 74-candidate batch visits existing binding keys linearly", () => {
  const inputs = Array.from({ length: 74 }, (_, index) => ({ record: fixture({ skill: "member-" + index }).record, scope }));
  const initial = bindCandidates(empty(), inputs);
  const observed = new Map(initial.state.bindings);
  let bindingReads = 0;
  for (const [ref, target] of observed) {
    observed.set(ref, new Proxy(target, { get(value, key, receiver) {
      if (key === "kind") bindingReads++;
      return Reflect.get(value, key, receiver);
    } }));
  }
  const state: SessionShortRefState = { bindings: observed };
  const repeated = bindCandidates(state, inputs);
  // Count existing-key work, not wall time. Repeated full scans exceed this by an order of magnitude.
  expect(bindingReads).toBeGreaterThan(0);
  expect(bindingReads).toBeLessThanOrEqual(inputs.length * 8);
  expect(repeated.refs).toEqual(initial.refs);
  expect(repeated.events).toEqual([]);
  expect(repeated.state).toBe(state);
});

test("candidate batch allocation leaves old selected and resource bindings unchanged", () => {
  const f = selectedResource(), saved = [...f.state.bindings];
  const plan = bindCandidates(f.state, [{ record: f.record, scope }, { record: fixture({ version: "two" }).record, scope }]);
  expect(plan.events).toHaveLength(1);
  expect(plan.refs[0]).toBe(plan.refs[1]);
  expect([...f.state.bindings]).toEqual(saved);
  expect(resolveSessionShortRef(plan.state, f.selected.ref, scope).canonicalRef).toBe(f.binding.ref);
  expect(resolveSessionShortRef(plan.state, f.resource.ref, scope).canonicalRef).toBe(f.files[1]!.ref);
  code(() => bindCandidates(f.state, [{ record: f.record, scope }, { record: f.record, scope: "invalid" }]), "SHORT_REF_INVALID");
  expect([...f.state.bindings]).toEqual(saved);
});

test("directory, Members and search reuse one candidate despite display metadata changes", () => {
  const f = fixture(), directory = bindCandidate(empty(), { record: f.record, scope });
  const members = bindCandidate(directory.state, { record: { ...f.record, name: "New display name", description: "Changed description" }, scope });
  const search = bindCandidate(members.state, { record: structuredClone(f.record), scope });
  expect([members.ref, search.ref]).toEqual([directory.ref, directory.ref]);
  expect(members.event).toBeUndefined();
  expect(search.event).toBeUndefined();
  expect(search.state.bindings.size).toBe(1);
  expect(Buffer.byteLength(directory.ref)).toBe(26);
  expect(resolveSessionShortRef(search.state, search.ref, scope)).toMatchObject({ kind: "candidate", canonicalRef: "skill://" + encodeURIComponent(f.record.id) });
});

test("same names in another account, library or physical source never merge", () => {
  const f = fixture(), first = bindCandidate(empty(), { record: f.record, scope });
  const account = bindCandidate(first.state, { record: f.record, scope: otherScope });
  const library = bindCandidate(account.state, { record: fixture({ library: "other-library" }).record, scope });
  const source = bindCandidate(library.state, { record: { ...f.record, locator: { ...f.record.locator, database_id: page("99") } }, scope });
  expect(new Set([first.ref, account.ref, library.ref, source.ref]).size).toBe(4);
  code(() => resolveSessionShortRef(source.state, first.ref, otherScope), "SHORT_REF_SCOPE_MISMATCH");
  code(() => resolveSessionShortRef(source.state, account.ref, scope), "SHORT_REF_SCOPE_MISMATCH");
});

test("selection creates a distinct fixed handle and never upgrades a candidate in place", () => {
  const f = fixture(), candidate = bindCandidate(empty(), { record: f.record, scope });
  const selected = bindSelected(candidate.state, f.binding);
  const again = bindSelected(selected.state, { ...f.binding, record: { ...f.record, description: "new metadata" } });
  expect(selected.ref.startsWith("sr:S")).toBe(true);
  expect(selected.ref).not.toBe(candidate.ref);
  expect(again.event).toBeUndefined();
  expect(again.ref).toBe(selected.ref);
  expect(resolveSessionShortRef(again.state, candidate.ref, scope).kind).toBe("candidate");
  expect(resolveSessionShortRef(again.state, selected.ref, scope)).toMatchObject({ kind: "selected", canonicalRef: f.binding.ref,
    selection: { snapshot_id: f.binding.snapshot_id, version_id: f.binding.version_id, body_sha256: f.binding.body_sha256 } });
  code(() => exportSessionShortRef(again.state, candidate.ref, scope), "SHORT_REF_NOT_PINNED");
});

test("refresh is a new binding; a conflicting claim about the same snapshot fails", () => {
  const old = fixture(), current = fixture({ version: "two" }), first = bindSelected(empty(), old.binding);
  const refreshed = bindSelected(first.state, current.binding);
  expect(refreshed.ref).not.toBe(first.ref);
  expect(resolveSessionShortRef(refreshed.state, first.ref, scope).canonicalRef).toBe(old.binding.ref);
  expect(resolveSessionShortRef(refreshed.state, refreshed.ref, scope).canonicalRef).toBe(current.binding.ref);
  code(() => bindSelected(refreshed.state, { ...old.binding, version_id: current.binding.version_id }), "SHORT_REF_CONFLICT");
  code(() => bindSelected(refreshed.state, { ...old.binding, body_sha256: hash("replaced body") }), "SHORT_REF_CONFLICT");
  expect(bindSelected(refreshed.state, old.binding).event).toBeUndefined();
});

test("serialized resume is deterministic and compaction does not infer handles from prose", () => {
  const f = fixture(), candidate = bindCandidate(empty(), { record: f.record, scope });
  const result = selectedResource(f, candidate.state);
  const branch = [entry(event(candidate)), entry(event(result.selected)), entry(event(result.resource))];
  const compacted: SessionEntry[] = [...branch, { type: "compaction", data: { summary: "The Skill was read" } }];
  const serialized = JSON.stringify(compacted);
  const restored = reduceSessionShortRefs(JSON.parse(serialized)), restoredAgain = reduceSessionShortRefs(JSON.parse(serialized));
  expect([...restored.bindings]).toEqual([...restoredAgain.bindings]);
  expect(resolveSessionShortRef(restored, result.resource.ref, scope).canonicalRef).toBe(f.files[1]!.ref);
  expect(bindResource(restored, result.selected.ref, f.snapshot, f.files[1]!.ref).event).toBeUndefined();
  expect(JSON.stringify(compacted)).toBe(serialized);
  const prose: SessionEntry[] = [{ type: "message", customType: SESSION_SHORT_REF_ENTRY, data: event(result.selected),
    message: { role: "user", content: JSON.stringify(branch) } }, { type: "compaction", data: { summary: result.resource.ref } }];
  code(() => resolveSessionShortRef(reduceSessionShortRefs(prose), result.resource.ref, scope), "SHORT_REF_UNKNOWN");
});

test("forks inherit ancestor handles but reject sibling-only and abandoned-future handles", () => {
  const f = fixture(), ancestor = bindCandidate(empty(), { record: f.record, scope });
  const left = selectedResource(f, ancestor.state), right = selectedResource(fixture({ version: "two" }), ancestor.state);
  const leftBranch = reduceSessionShortRefs([entry(event(ancestor)), entry(event(left.selected)), entry(event(left.resource))]);
  const rightBranch = reduceSessionShortRefs([entry(event(ancestor)), entry(event(right.selected)), entry(event(right.resource))]);
  expect(resolveSessionShortRef(leftBranch, ancestor.ref, scope).kind).toBe("candidate");
  expect(resolveSessionShortRef(rightBranch, ancestor.ref, scope).kind).toBe("candidate");
  code(() => resolveSessionShortRef(leftBranch, right.resource.ref, scope), "SHORT_REF_UNKNOWN");
  code(() => resolveSessionShortRef(rightBranch, left.selected.ref, scope), "SHORT_REF_UNKNOWN");
  const rewound = reduceSessionShortRefs([entry(event(ancestor))]), reallocated = bindSelected(rewound, f.binding);
  expect(reallocated.ref).not.toBe(left.selected.ref);
  code(() => resolveSessionShortRef(reallocated.state, left.selected.ref, scope), "SHORT_REF_UNKNOWN");
  code(() => resolveSessionShortRef(empty(), ancestor.ref, scope), "SHORT_REF_UNKNOWN");
});

test("only a complete canonical token is accepted; errors never echo arbitrary input", () => {
  const f = selectedResource();
  for (const value of ["owner", "S3", "/machine-private/credential", f.selected.ref + "/SKILL.md", f.selected.ref + "?snapshot=anything",
    " " + f.selected.ref, f.selected.ref + "\n", f.selected.ref.slice(0, -1), "sr:S" + "A".repeat(21) + "B", f.selected.ref + "extra"]) {
    code(() => resolveSessionShortRef(f.state, value, scope), "SHORT_REF_INVALID");
  }
  code(() => resolveSessionShortRef(f.state, "sr:S" + randomBytes(16).toString("base64url"), scope), "SHORT_REF_UNKNOWN");
  try { resolveSessionShortRef(f.state, "sr:secret-credential", scope); } catch (error) {
    expect(String(error)).not.toContain("secret-credential");
  }
});

test("replay refuses rebinding, duplicate aliases, unsupported versions and resource-before-owner", () => {
  const f = selectedResource(), changed = bindSelected(empty(), fixture({ skill: "another" }).binding);
  code(() => reduceSessionShortRefs([entry(event(f.selected)), entry({ ...event(changed), ref: f.selected.ref })]), "SHORT_REF_CONFLICT");
  const duplicate = bindSelected(empty(), f.binding);
  code(() => reduceSessionShortRefs([entry(event(f.selected)), entry(event(duplicate))]), "SHORT_REF_CONFLICT");
  code(() => reduceSessionShortRefs([entry({ ...event(f.selected), version: 2 })]), "SHORT_REF_INVALID");
  code(() => reduceSessionShortRefs([entry({ ...event(f.selected), ref: f.selected.ref.replace("sr:S", "sr:C") })]), "SHORT_REF_INVALID");
  code(() => reduceSessionShortRefs([entry(event(f.resource))]), "SHORT_REF_OWNER_MISMATCH");
  const duplicated = reduceSessionShortRefs([entry(event(f.selected)), entry(event(f.selected))]);
  expect(duplicated.bindings.size).toBe(1);
});

test("stable File ID resolves a move within the chosen historical owner, never another snapshot", () => {
  const old = selectedResource(), movedFixture = fixture({ version: "two", resource: "moved/guide.md" });
  const moved = selectedResource(movedFixture, old.state);
  const formerSpelling = moved.files[1]!.ref.replace("moved/guide.md", old.resourcePath);
  const repeated = bindResource(moved.state, moved.selected.ref, moved.snapshot, formerSpelling);
  expect(repeated.ref).toBe(moved.resource.ref);
  expect(repeated.event).toBeUndefined();
  expect(resolveSessionShortRef(moved.state, old.resource.ref, scope).canonicalRef).toBe(old.files[1]!.ref);
  expect(resolveSessionShortRef(moved.state, moved.resource.ref, scope).canonicalRef).toBe(moved.files[1]!.ref);
  code(() => bindResource(moved.state, moved.selected.ref, moved.snapshot, old.files[1]!.ref), "SHORT_REF_OWNER_MISMATCH");
  code(() => bindResource(moved.state, moved.selected.ref, moved.snapshot, formerSpelling.replace("&file_id=guide", "")), "SHORT_REF_OWNER_MISMATCH");
  const movedWithinOldSnapshot = fixture({ resource: "moved/guide.md" });
  code(() => bindResource(old.state, old.selected.ref, movedWithinOldSnapshot.snapshot, movedWithinOldSnapshot.files[1]!.ref), "SHORT_REF_CONFLICT");
});

test("resources reject candidates, mismatched scope, owner, version, File ID and manifest", () => {
  const f = selectedResource(), candidate = bindCandidate(f.state, { record: f.record, scope });
  code(() => bindResource(candidate.state, candidate.ref, f.snapshot, f.files[1]!.ref), "SHORT_REF_OWNER_MISMATCH");
  for (const snapshot of [
    { ...f.snapshot, sourceScope: otherScope }, { ...f.snapshot, snapshotId: "s_" + hash("other") },
    { ...f.snapshot, id: "other-owner" }, { ...f.snapshot, versionId: "different" },
    { ...f.snapshot, locator: { ...f.snapshot.locator!, database_id: page("99") } },
    { ...f.snapshot, entryManifest: undefined }, fixture({ skill: "another" }).snapshot,
  ]) code(() => bindResource(f.state, f.selected.ref, snapshot, f.files[1]!.ref), "SHORT_REF_OWNER_MISMATCH");
  for (const ref of [f.files[1]!.ref.replace("file_id=guide", "file_id=foreign"), fixture({ skill: "another" }).files[1]!.ref,
    f.files[1]!.ref.replace("&file_id=guide", "").replace(f.resourcePath, "missing.md")]) {
    code(() => bindResource(f.state, f.selected.ref, f.snapshot, ref), "SHORT_REF_OWNER_MISMATCH");
  }
  const ambiguous = { ...f.snapshot, fileBindings: [...f.snapshot.fileBindings!, { file_id: "guide", page_id: page("3"), path: "other.md" }] };
  code(() => bindResource(f.state, f.selected.ref, ambiguous, f.files[1]!.ref), "SHORT_REF_OWNER_MISMATCH");
  const duplicateManifest = { ...f.snapshot, entryManifest: { ...f.snapshot.entryManifest!, files: [...f.files, f.files[1]!] } };
  code(() => bindResource(f.state, f.selected.ref, duplicateManifest, f.files[1]!.ref), "SHORT_REF_OWNER_MISMATCH");
  code(() => bindResource(f.state, f.selected.ref, f.snapshot, f.files[1]!.ref.replace(f.resourcePath, "../secret")), "SHORT_REF_INVALID");
});

test("main-file references reuse the selected handle and legacy resources remain exact pinned paths", () => {
  const f = fixture({ fileId: false }), selected = bindSelected(empty(), f.binding);
  const main = bindResource(selected.state, selected.ref, f.snapshot, f.files[0]!.ref);
  expect(main.ref).toBe(selected.ref);
  expect(main.event).toBeUndefined();
  const resource = bindResource(main.state, selected.ref, f.snapshot, f.files[1]!.ref);
  expect(resolveSessionShortRef(resource.state, resource.ref, scope)).toMatchObject({ kind: "resource", canonicalRef: f.files[1]!.ref });
  expect(f.snapshot.entryManifest?.materialized_paths).toEqual(["SKILL.md"]);
  expect(f.snapshot.entryManifest?.local_files_ready).toBe(false);
  code(() => bindResource(resource.state, selected.ref, f.snapshot, f.files[1]!.ref.replace(f.resourcePath, "old-location.md")), "SHORT_REF_OWNER_MISMATCH");
});

test("identical File IDs in different owners remain different resources", () => {
  const first = selectedResource(), second = selectedResource(fixture({ skill: "second-owner" }), first.state);
  expect(second.resource.ref).not.toBe(first.resource.ref);
  expect(resolveSessionShortRef(second.state, first.resource.ref, scope).canonicalRef).toBe(first.files[1]!.ref);
  code(() => bindResource(second.state, first.selected.ref, second.snapshot, second.files[1]!.ref), "SHORT_REF_OWNER_MISMATCH");
});

test("canonical and short routes identify exactly the same fixture bytes and selected version", () => {
  const f = selectedResource();
  const canonicalRead = (ref: string) => {
    const parsed = parseNativeReference(ref), selectedPath = nativeResourcePath(parsed, f.snapshot);
    return { bytes: f.bytes.get(selectedPath), snapshot: parsed.snapshot };
  };
  for (const [handle, ref] of [[f.selected.ref, f.binding.ref], [f.resource.ref, f.files[1]!.ref]]) {
    const resolved = resolveSessionShortRef(f.state, handle!, scope);
    const direct = canonicalRead(ref!), shortened = canonicalRead(resolved.canonicalRef);
    expect(shortened).toEqual(direct);
    expect(shortened.snapshot).toBe(f.binding.snapshot_id);
    expect(shortened.bytes?.length).toBeGreaterThan(0);
  }
  // Resolution itself cannot authorize the returned locator. The normal source
  // boundary still rejects a revoked grant, even when a saved handle exists.
  const resolved = resolveSessionShortRef(f.state, f.selected.ref, scope);
  const authorizedRead = (_ref: string) => { throw Object.assign(new Error("Current source grant revoked"), { code: "SOURCE_PERMISSION_DENIED" }); };
  code(() => authorizedRead(resolved.canonicalRef), "SOURCE_PERMISSION_DENIED");
});

test("portable export includes exact source/version/File ID and excludes local handles and incidental secrets", () => {
  const f = fixture();
  f.record.name = "incidental-name-secret";
  f.record.description = "incidental-description-secret";
  f.record.upstream = { repo: "incidental-upstream-secret" };
  f.snapshot.token = "incidental-token-secret";
  const result = selectedResource(f), exported = exportSessionShortRef(result.state, result.resource.ref, scope);
  expect(exported).toMatchObject({ version: 1, kind: "fixed_skill_reference", ref: f.files[1]!.ref,
    owner: { identity: { scope, id: f.record.id, source: "notion", locator: f.record.locator }, snapshot_id: f.binding.snapshot_id,
      version_id: f.binding.version_id, body_sha256: f.binding.body_sha256 }, file: { file_id: "guide", path: f.resourcePath, sha256: f.files[1]!.sha256, bytes: f.files[1]!.bytes } });
  const serialized = JSON.stringify(exported);
  for (const unwanted of ["sr:", "machine-private", "incidental-", "signed_url", "access_token"]) expect(serialized).not.toContain(unwanted);
  code(() => resolveSessionShortRef(empty(), result.resource.ref, scope), "SHORT_REF_UNKNOWN");
  code(() => exportSessionShortRef(result.state, result.resource.ref, otherScope), "SHORT_REF_SCOPE_MISMATCH");
});

test("input mutation cannot silently change a saved identity or selected snapshot", () => {
  const f = fixture(), plan = bindSelected(empty(), f.binding), saved = JSON.stringify(event(plan));
  if (f.record.locator.type === "shared_skill") f.record.locator.library_id = "changed-after-binding";
  f.binding.version_id = "changed-after-binding";
  expect(JSON.stringify(event(plan))).toBe(saved);
  const originalEvent = JSON.parse(saved), restored = reduceSessionShortRefs([entry(originalEvent)]);
  originalEvent.target.snapshot_id = "s_" + hash("changed-after-replay");
  expect(resolveSessionShortRef(restored, plan.ref, scope)).toMatchObject({ kind: "selected", selection: { snapshot_id: "s_" + hash("snapshot one") } });
  const extra = JSON.parse(saved); extra.target.identity.access_token = "unwanted";
  code(() => reduceSessionShortRefs([entry(extra)]), "SHORT_REF_INVALID");
});

test("canonical identity and locator agree for page, subscription and shared records; local is explicit unsupported", () => {
  const f = fixture();
  const pageRecord: ContentRecord = { ...f.record, id: "notion_page:" + page("20"), ref: "skill://" + page("20") + "/SKILL.md",
    locator: { type: "notion_page", page_id: page("20"), database_id: page("10"), data_source_id: page("11") } };
  const subscription: ContentRecord = { ...f.record, kind: "router", id: "notion_subscription:" + page("30"), entrypoint: "ROUTER.md",
    ref: "skill://" + encodeURIComponent("upstream:" + page("30")) + "/ROUTER.md",
    locator: { type: "notion_subscription", subscription_id: page("30"), database_id: page("10"), data_source_id: page("11"), target_database_id: page("31") } };
  const first = bindCandidate(empty(), { record: pageRecord, scope });
  const second = bindCandidate(first.state, { record: subscription, scope });
  expect(second.state.bindings.size).toBe(2);
  code(() => bindCandidate(second.state, { record: { ...f.record, id: pageRecord.id }, scope }), "SHORT_REF_INVALID");
  code(() => bindCandidate(second.state, { record: { ...f.record, ref: pageRecord.ref }, scope }), "SHORT_REF_INVALID");
  code(() => bindCandidate(second.state, { record: { ...f.record, locator: { type: "local", id: "/private/local", entry: "/private/local/SKILL.md" } }, scope }), "SHORT_REF_UNSUPPORTED");
});
