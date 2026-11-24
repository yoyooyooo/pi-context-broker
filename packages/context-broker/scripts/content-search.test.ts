import { expect, test } from "bun:test";
import { contentSearchFailure, decodeContentSearchResult, type ContentSearchResult } from "../src/content-search";

function result(): ContentSearchResult {
  return { kind: "results", connection: { id: "connection", grantEpoch: "epoch" }, resultId: "result",
    coverage: "remote_non_exhaustive", partial: false, exhaustive: false,
    notices: [{ code: "REMOTE_NON_EXHAUSTIVE", message: "No absence or exact-file claim." }],
    records: [{ id: "skill://entry?library=d81f4f38-325d-5797-995e-a48a903c6ae3", kind: "skill", name: "Entry", alias: "entry", description: "Purpose",
      enabled: true, default_context: false, entrypoint: "SKILL.md", ref: "skill://entry/SKILL.md?library=d81f4f38-325d-5797-995e-a48a903c6ae3",
      locator: { type: "shared_skill", library_id: "d81f4f38-325d-5797-995e-a48a903c6ae3", skill_id: "entry", page_id: "00000000-0000-4000-8000-000000000001",
        database_id: "00000000-0000-4000-8000-000000000002", data_source_id: "00000000-0000-4000-8000-000000000003" },
      match: { kind: "notion_remote_match", pageId: "00000000-0000-4000-8000-000000000001",
        url: "https://www.notion.so/00000000000040008000000000000001", snippet: "Needle", representation: "projection" } }] };
}

test("the SDK content boundary preserves admitted metadata and copies only declared fields", () => {
  const input = result(), item = input.records[0]!;
  const decoded = decodeContentSearchResult({ ...input, raw: "PRIVATE_PAYLOAD", access_token: "PRIVATE_TOKEN",
    records: [{ ...item, secret: "PRIVATE_RECORD", match: { ...item.match, raw: "PRIVATE_MATCH" } }] });
  expect(decoded).toEqual(input);
  expect(JSON.stringify(decoded)).not.toContain("PRIVATE");
  expect(decodeContentSearchResult({ ...input, records: [], partial: true })).toMatchObject({
    records: [], partial: true, exhaustive: false, coverage: "remote_non_exhaustive",
  });
});

test("content results reject wrong owners, unbounded text and unsupported protocol shapes", () => {
  const input = result(), item = input.records[0]!;
  for (const changed of [
    { ...input, exhaustive: true },
    { ...input, connection: { id: "connection", grantEpoch: 1 } },
    { ...input, records: [{ ...item, enabled: false }] },
    { ...input, records: [{ ...item, ref: "skill://another/SKILL.md?library=d81f4f38-325d-5797-995e-a48a903c6ae3" }] },
    { ...input, records: [{ ...item, ref: item.ref + "&file_id=supporting-file" }] },
    { ...input, records: [{ ...item, match: { ...item.match, representation: "exact_bytes" } }] },
    { ...input, records: [{ ...item, match: { ...item.match, url: "javascript:alert(1)" } }] },
    { ...input, records: [{ ...item, match: { ...item.match, snippet: "x".repeat(8193) } }] },
    { ...input, records: Array.from({ length: 51 }, () => item) },
    { ...input, records: Array.from({ length: 50 }, () => ({ ...item, description: "x".repeat(8192) })) },
    { ...input, notices: [{ code: "REMOTE", message: "\u001b[31mPRIVATE" }] },
  ]) expect(() => decodeContentSearchResult(changed)).toThrow();
});

test("safe error classification preserves useful codes without copying transport diagnostics", () => {
  for (const code of ["MCP_AUTH_REQUIRED", "MCP_AUTH_REAUTH_REQUIRED", "MCP_AUTH_INTERACTION_REQUIRED", "MCP_AUTH_BROWSER_UNAVAILABLE"]) {
    const failure = contentSearchFailure(Object.assign(new Error("PRIVATE_TOKEN"), { code, details: { raw: "PRIVATE_SNIPPET" } }));
    expect(failure).toMatchObject({ state: "auth_required", error: { code }, exhaustive: false });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE");
    expect(failure.error.message).toContain("ntn-skills auth mcp login");
  }
  expect(contentSearchFailure({ code: "MCP_AUTH_DENIED" })).toMatchObject({ state: "failed", error: { code: "MCP_AUTH_DENIED" } });
  expect(contentSearchFailure({ code: "MCP_UNSUPPORTED" })).toMatchObject({ state: "unsupported" });
  expect(contentSearchFailure({ code: "MCP_CANCELLED" })).toMatchObject({ state: "cancelled" });
  expect(contentSearchFailure({ code: "PRIVATE_TOKEN" })).toMatchObject({ error: { code: "CONTENT_SEARCH_FAILED" } });
});
