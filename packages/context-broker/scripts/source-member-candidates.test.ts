import { expect, test } from "bun:test";
import { candidateMetadata, createCompletionSnapshot, materializationCompletionCandidates, matchSourceMemberCandidate, sourceMemberCompletionCandidates, sourceMemberLookupQuery } from "../src/completion-candidates";
import { completionCandidateItems } from "../src/dollar";
import { explicitDollarQueries } from "../src/invocation-text";
import { matchesPreciseRecordToken, preciseRecordToken } from "../src/discovery-records";
import type { DiscoveryRecord } from "../src/types";
import type { SourceMemberCandidate, SourceMaterializationReceipt } from "../src/source-materialization-contract";

const source = { id: "notion", type: "notion", namespace: "team", library: "00000000-0000-4000-8000-000000000001" } as const;
const member: SourceMemberCandidate = { type: "source_member", source_id: "registered-origin", member_key: "skills/root", expected_skill_id: "origin-root",
  library_id: source.library, scope: "a".repeat(64), registration_digest: "b".repeat(64), expected_source_commit: "c".repeat(40),
  name: "Root", alias: "root", description: "Registered upstream root", enabled: true, readiness: "materializable" };

test("an unmaterialized completion carries metadata and an exact target, never a page or consumable ref", () => {
  const candidates = sourceMemberCompletionCandidates([member], source);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({ origin: "source_member", source: { id: "notion" }, member: { source_id: "registered-origin" } });
  expect(candidates[0]).not.toHaveProperty("record");
  expect(candidateMetadata(candidates[0]!)).toEqual({ kind: "skill", name: "Root", alias: "root", description: member.description });
  const items = completionCandidateItems(candidates, "root");
  expect(items).toHaveLength(1);
  expect(items[0]).not.toHaveProperty("ref");
  expect(items[0]!.description).toContain("materializable");
});

test("partial and ambiguous discovery cannot infer a unique alias; an exact target keeps its binding", () => {
  expect(() => matchSourceMemberCandidate("root@team", source, [member], "partial")).toThrow();
  expect(() => matchSourceMemberCandidate("root@team", source, [member, { ...member, source_id: "other-origin", expected_skill_id: "other" }], "complete")).toThrow();
  expect(matchSourceMemberCandidate("root@team", source, [member], "complete")).toBe(member);
  expect(matchSourceMemberCandidate("root@another", source, [member], "complete")).toBeUndefined();
  const token = sourceMemberCompletionCandidates([member], source)[0]!.token;
  expect(token).toBe("root@skill%3Aorigin-root@team");
  expect(explicitDollarQueries("$" + token)).toEqual(new Set([token]));
  expect(sourceMemberLookupQuery(token, source)).toBe("origin-root");
  expect(() => matchSourceMemberCandidate(token, source, [member], "partial")).toThrow();
  expect(matchSourceMemberCandidate(token, source, [member], "complete")).toBe(member);
  const renamed = { ...member, alias: "renamed" };
  expect(matchSourceMemberCandidate(token, source, [renamed], "complete")).toBe(renamed);
});

test("disabled registered members are not completion choices", () => {
  expect(sourceMemberCompletionCandidates([{ ...member, enabled: false }], source)).toEqual([]);
});


test("a Source member selection resolves the later physical record without rediscovery", () => {
  const token = sourceMemberCompletionCandidates([member], source)[0]!.token;
  const physical: DiscoveryRecord = { kind: "skill", id: "skill://origin-root?library=" + source.library,
    name: "Renamed root", alias: "renamed", description: member.description, path: "/metadata/renamed/SKILL.md",
    normalizedName: "renamed", normalizedAliases: [], normalizedDescription: "registered-upstream-root",
    source: "notion", sourceId: source.id, sourceScope: member.scope, token: "team/renamed", enabled: true,
    locator: { type: "shared_skill", library_id: source.library, skill_id: member.expected_skill_id,
      page_id: "00000000-0000-4000-8000-000000000002", database_id: "00000000-0000-4000-8000-000000000003", data_source_id: "00000000-0000-4000-8000-000000000004" } };
  if (physical.locator?.type !== "shared_skill") throw new Error("Expected the real physical locator");
  expect(matchesPreciseRecordToken(token, physical)).toBe(true);
  expect(matchesPreciseRecordToken(token.replace("@team", "@other"), physical)).toBe(false);
  expect(matchesPreciseRecordToken(token, { ...physical, locator: { ...physical.locator, skill_id: "another" } })).toBe(false);
  expect(matchesPreciseRecordToken(preciseRecordToken(physical), physical)).toBe(true);
  // A hex-only stable ID cannot be confused with another record's page ID.
  const hex = "00000000000040008000000000000002";
  const hexToken = sourceMemberCompletionCandidates([{ ...member, expected_skill_id: hex }], source)[0]!.token;
  expect(matchesPreciseRecordToken(hexToken, physical)).toBe(false);
});


test("a blocked zero-write receipt retires its stale candidate even with an empty affected set", () => {
  const sibling = { ...member, member_key: "skills/sibling", expected_skill_id: "origin-sibling", alias: "sibling" };
  const otherScope = { ...member, scope: "f".repeat(64) };
  const snapshot = createCompletionSnapshot(() => {});
  snapshot.accept(snapshot.begin("cache"), sourceMemberCompletionCandidates([member, sibling, otherScope], source));
  const receipt: SourceMaterializationReceipt = { version: 1, request_id: "stale-preflight", library_id: source.library,
    scope: member.scope, target: { source_id: member.source_id, member_key: member.member_key,
      expected_skill_id: member.expected_skill_id, registration_digest: member.registration_digest },
    status: "blocked", reason: "SOURCE_REGISTRATION_CHANGED", records: [], affected_skill_ids: [], source_revisions: [],
    effects: { remote_writes: "none", projection: "none" } };
  snapshot.accept(snapshot.begin("refresh"), materializationCompletionCandidates(snapshot.read().candidates, source, receipt));
  expect(snapshot.read().candidates).toEqual(sourceMemberCompletionCandidates([sibling, otherScope], source));
  const fresh = { ...member, registration_digest: "e".repeat(64) };
  snapshot.accept(snapshot.begin("refresh"), sourceMemberCompletionCandidates([fresh, sibling], source));
  expect(snapshot.read().candidates.find(candidate => candidate.origin === "source_member" && candidate.member.expected_skill_id === member.expected_skill_id))
    .toMatchObject({ member: { registration_digest: fresh.registration_digest } });
});
