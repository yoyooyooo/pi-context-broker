import { expect, test } from "bun:test";
import { decodeSourceMaterializationReceipt, decodeSourceMemberCandidate, materializationTarget, type SourceMaterializationRequest } from "../src/source-materialization-contract";
import type { ContentRecord } from "../src/types";

const library = "00000000-0000-4000-8000-000000000001", scope = "a".repeat(64);
const target = { source_id: "registered-origin", member_key: "skills/root", expected_skill_id: "legacy-root", registration_digest: "b".repeat(64), expected_source_commit: "e".repeat(40) };
const record: ContentRecord = { id: "skill://legacy-root?library=" + library, kind: "skill", name: "Root", alias: "root", description: "Registered root",
  entrypoint: "SKILL.md", ref: "skill://legacy-root/SKILL.md?library=" + library, default_context: false, enabled: true,
  locator: { type: "shared_skill", library_id: library, skill_id: "legacy-root", page_id: "00000000-0000-4000-8000-000000000002",
    database_id: "00000000-0000-4000-8000-000000000003", data_source_id: "00000000-0000-4000-8000-000000000004" } };
// This boundary receives physical records from the separately tested ordinary
// ContentRecord decoder. The fixture accepts exactly that validated record.
function physical(input: unknown): ContentRecord {
  if (JSON.stringify(input) !== JSON.stringify(record)) throw new Error("Not the validated physical record");
  return record;
}
const request: SourceMaterializationRequest = { version: 1, library, request_id: "accepted-input:root", purpose: "use", target };
const ready = () => ({ version: 1, request_id: request.request_id, library_id: library, scope, target, status: "ready", operation_id: "operation-root",
  records: [record], affected_skill_ids: ["legacy-root"], source_revisions: [{ source_id: target.source_id, revision: "c".repeat(64) }],
  effects: { remote_writes: "management", projection: "none" } });

test("a registered candidate without a physical row cannot masquerade as current-ready", () => {
  const candidate = { ...target, type: "source_member", library_id: library, scope, name: "Root", alias: "root", description: "Registered root", enabled: true, readiness: "materializable" };
  expect(decodeSourceMemberCandidate(candidate, { library, scope }, physical).record).toBeUndefined();
  expect(() => decodeSourceMemberCandidate({ ...candidate, readiness: "ready" }, { library, scope }, physical)).toThrow();
  expect(() => decodeSourceMemberCandidate({ ...candidate, expected_skill_id: "other", record }, { library, scope }, physical)).toThrow();
  for (const member_key of ["../root", "/root", "skills//root", "skills/.git/root", "skills\\root"])
    expect(() => materializationTarget({ ...target, member_key })).toThrow();
});

test("receipt admission binds the accepted request, Library, scope and exact registered root", () => {
  expect(decodeSourceMaterializationReceipt(ready(), request, scope, physical).records).toEqual([record]);
  for (const patch of [
    { request_id: "another-input" }, { library_id: "00000000-0000-4000-8000-000000000099" }, { scope: "d".repeat(64) },
    { target: { ...target, member_key: "skills/other" } }, { target: { ...target, expected_source_commit: "f".repeat(40) } }, { records: [] }, { records: [record, record] },
    { source_revisions: [] }, { effects: { remote_writes: "unknown", projection: "none" } },
    { effects: { remote_writes: "management", projection: "written" } },
  ]) expect(() => decodeSourceMaterializationReceipt({ ...ready(), ...patch }, request, scope, physical)).toThrow();
});

test("pending management preserves unknown effects and supplies no consumable records", () => {
  const pending = { ...ready(), status: "pending", records: [], source_revisions: [], affected_skill_ids: [], effects: { remote_writes: "unknown", projection: "none" } };
  expect(decodeSourceMaterializationReceipt(pending, request, scope, physical).effects.remote_writes).toBe("unknown");
  expect(() => decodeSourceMaterializationReceipt({ ...pending, records: [record] }, request, scope, physical)).toThrow();
});

test("a Required-member receipt cannot be replayed under another accepted root or relationship observation", () => {
  const authorization = { skill_id: "native-router", page_id: "00000000-0000-4000-8000-000000000009", requires_digest: "f".repeat(64) };
  const authorized = { ...request, authorization_root: authorization };
  expect(decodeSourceMaterializationReceipt({ ...ready(), authorization_root: authorization }, authorized, scope, physical).authorization_root).toEqual(authorization);
  expect(() => decodeSourceMaterializationReceipt(ready(), authorized, scope, physical)).toThrow();
  expect(() => decodeSourceMaterializationReceipt({ ...ready(), authorization_root: authorization }, request, scope, physical)).toThrow();
  for (const patch of [{ skill_id: "different-root" }, { requires_digest: "0".repeat(64) }, { page_id: "00000000-0000-4000-8000-000000000008" }])
    expect(() => decodeSourceMaterializationReceipt({ ...ready(), authorization_root: { ...authorization, ...patch } }, authorized, scope, physical)).toThrow();
});


test("manager attribution cannot replace the consumer credential scope", () => {
  const managerScope = "9".repeat(64);
  expect(decodeSourceMaterializationReceipt({ ...ready(), manager_scope: managerScope }, request, scope, physical))
    .toMatchObject({ scope, manager_scope: managerScope });
  expect(() => decodeSourceMaterializationReceipt({ ...ready(), scope: managerScope, manager_scope: managerScope }, request, scope, physical)).toThrow();
  expect(() => decodeSourceMaterializationReceipt({ ...ready(), manager_scope: "" }, request, scope, physical)).toThrow();
});
