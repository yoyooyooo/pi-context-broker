import { expect, test } from "bun:test";
import { authorizeExplicitPreparation, authorizedPreparationRoots, preparationBudget, revokePreparationAuthority } from "../src/preparation-authority";
import { createInputReceipt, withContextPreparationDeadline } from "../src/skill-preparation";
import { explicitDollarQueries } from "../src/invocation-text";
import type { ExtensionContext, SkillRecord } from "../src/types";

function fixture(text = "$root@notion") {
  const state = { session: "session-a", branch: [{ id: "entry-a" }] };
  const ctx: ExtensionContext = { cwd: "/owned/workspace", sessionManager: {
    getSessionId: () => state.session, getBranch: () => state.branch,
  } };
  const record: SkillRecord = { source: "notion", sourceId: "notion", sourceScope: "a".repeat(64),
    id: "skill://root?library=00000000-0000-4000-8000-000000000001",
    name: "root", description: "Registered root", alias: "root", path: "/owned/root/SKILL.md", aliases: [],
    normalizedName: "root", normalizedAliases: [], normalizedDescription: "registered root", autoloadEnabled: true };
  const receipt = createInputReceipt({ text }, ctx);
  return { state, ctx, record, receipt };
}

test("management authority belongs to the literal accepted root, source and scope", () => {
  const f = fixture();
  const authority = authorizeExplicitPreparation(f.receipt, [{ query: "root@notion", record: f.record }]);
  expect(authority).toBeDefined();
  const guessed = { ...f.record, id: "skill://guessed?library=00000000-0000-4000-8000-000000000001" };
  expect(authorizedPreparationRoots(authority, [f.record, guessed, { ...f.record, sourceId: "other" },
    { ...f.record, sourceScope: "b".repeat(64) }], f.ctx, undefined)).toEqual([f.record]);
  expect(authorizedPreparationRoots({ receiptId: f.receipt.id }, [f.record], f.ctx, undefined)).toEqual([]);
});

test("code, quoted examples, configurable injections and absent input cannot grant writes", () => {
  for (const text of ["Use a configured root", "`$root@notion`", "```md\n$root@notion\n```", "> $root@notion", "    $root@notion", "\\$root@notion"]) {
    const f = fixture(text);
    expect(authorizeExplicitPreparation(f.receipt, [{ query: "root@notion", record: f.record }])).toBeUndefined();
  }
  const f = fixture();
  expect(authorizeExplicitPreparation(undefined, [{ query: "root@notion", record: f.record }])).toBeUndefined();
  expect(authorizeExplicitPreparation(f.receipt, [{ query: "guessed", record: f.record }])).toBeUndefined();
});

test("cancel, session switch and branch replacement retire the input authority", () => {
  const f = fixture();
  const authority = authorizeExplicitPreparation(f.receipt, [{ query: "root@notion", record: f.record }]);
  const cancelled = new AbortController(); cancelled.abort();
  expect(authorizedPreparationRoots(authority, [f.record], f.ctx, cancelled.signal)).toEqual([]);
  f.state.session = "session-b";
  expect(authorizedPreparationRoots(authority, [f.record], f.ctx, undefined)).toEqual([]);
  f.state.session = "session-a"; f.state.branch.push({ id: "entry-b" });
  expect(authorizedPreparationRoots(authority, [f.record], f.ctx, undefined)).toEqual([f.record]);
  f.state.branch = [{ id: "entry-other" }];
  expect(authorizedPreparationRoots(authority, [f.record], f.ctx, undefined)).toEqual([]);
});

test("a completed preflight cannot lend its authority to a later consumer", () => {
  const f = fixture();
  const authority = authorizeExplicitPreparation(f.receipt, [{ query: "root@notion", record: f.record }]);
  revokePreparationAuthority(authority);
  expect(authorizedPreparationRoots(authority, [f.record], f.ctx, undefined)).toEqual([]);
});


test("unqualified amounts and shell variables cannot become Source management intent", () => {
  expect(explicitDollarQueries("Amounts $10 and $1.25; vars $HOME ${USER} $lowercase_skill")).toEqual(new Set(["lowercase_skill"]));
  expect(explicitDollarQueries("$HOME@notion $10@notion")).toEqual(new Set(["HOME@notion", "10@notion"]));
});


test("the context budget follows only a current issued grant and is removed with that grant", async () => {
  const f = fixture();
  await withContextPreparationDeadline(new AbortController().signal, async (_signal, budget) => {
    const authority = authorizeExplicitPreparation(f.receipt, [{ query: "root@notion", record: f.record }], budget);
    expect(preparationBudget(authority)).toBe(budget);
    expect(preparationBudget({ receiptId: f.receipt.id })).toBeUndefined();
    revokePreparationAuthority(authority);
    expect(preparationBudget(authority)).toBeUndefined();
  });
});
