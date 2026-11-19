import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { currentNotionFixture } from "./fixtures/current-notion-source";
import type { ContentRecord, ExtensionAPI, ExtensionContext, SkillRecord, SourceConfig } from "../src/types";

const runtime = await currentNotionFixture();
const { decodeCliWriteOutput, installCliWriteInvalidation } = await import(pathToFileURL(join(runtime.root, "src/cli-write-invalidation.ts")).href);
const { hostCliScope } = await import(pathToFileURL(join(runtime.root, "src/host-command.ts")).href);
const db = "22222222-2222-4222-8222-222222222222", otherDb = "22222222-2222-4222-8222-222222222223";
const page = "11111111-1111-4111-8111-111111111111", ds = "33333333-3333-4333-8333-333333333333";
const operation = "import:current-1", skill = "skill:one", library = { library_id: "lib:current", database_id: db, data_source_id: ds };
const prefix = hostCliScope().command;
const quote = (word: string) => "'" + word.replaceAll("'", "'\\''") + "'";
const command = (...args: string[]) => [...prefix, ...args].map(quote).join(" ");
const args = ["ctl", "library", "import", "/staged", "--entry", db, "--skill-id", skill, "--operation", operation];
const currentCommand = command(...args);
const atEntry = (entry: string) => command("ctl", "library", "import", "/staged", "--entry", entry, "--skill-id", skill, "--operation", operation);
const entryUrls = [
  "https://www.notion.so/Library-" + db.replaceAll("-", "") + "?v=ignored",
  "https://app.notion.com/p/team/library-" + db.replaceAll("-", "") + "?source=copy_link",
  "https://team.notion.site/" + db.replaceAll("-", "").toUpperCase() + "/#section",
];
const current = { ok: true, contract: "current", status: "applied", operation_id: operation, skill_id: skill, page_id: page,
  input_sha256: "a".repeat(64), files: 3, state: "ready", library };
const sources: SourceConfig[] = [
  { id: "personal", type: "notion", database: db },
  { id: "second", type: "notion", database: otherDb },
  { id: "alias", type: "notion", database: "library" },
  { id: "disabled", type: "notion", database: db, enabled: false },
  { id: "unbound", type: "notion" },
];
function record(sourceId: string, locator: ContentRecord["locator"] = { type: "shared_skill", ...library, skill_id: skill, page_id: page }): SkillRecord {
  return { id: "shared_skill:lib%3Acurrent:skill%3Aone", kind: "skill", name: "visible name", alias: "visible-name", description: "Current item",
    default_context: false, enabled: true, entrypoint: "SKILL.md", ref: "skill://shared_skill%3Alib%253Acurrent%3Askill%253Aone/SKILL.md",
    locator, source: "notion", sourceId, sourceScope: "b".repeat(64), aliases: [], autoloadEnabled: true,
    path: "/metadata/SKILL.md", normalizedName: "visible-name", normalizedAliases: [], normalizedDescription: "Current item" };
}
let records = [record("personal"), record("alias")];
const listeners = new Map<string, unknown[]>(), changed: string[][] = [];
const ctx: ExtensionContext = { cwd: "/owned", sessionManager: { getSessionId: () => "write-session" } };
const otherCtx: ExtensionContext = { sessionManager: { getSessionId: () => "different-session" } };
const api: ExtensionAPI = { on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); } };
const emit = async (name: string, event: unknown, context = ctx) => {
  for (const handler of listeners.get(name) ?? []) { if (typeof handler !== "function") throw Error("Expected listener"); await handler(event, context); }
};
installCliWriteInvalidation(api, { sources, records: () => records, changed: ids => changed.push(ids) });
let nextId = 0;
async function result(cmd: string, value: unknown, isError = false, context = ctx) {
  const toolCallId = "call-" + nextId++, input = { command: cmd };
  await emit("tool_call", { toolName: "bash", toolCallId, input }, context);
  await emit("tool_result", { toolName: "bash", toolCallId, input, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError }, context);
}
const changedLibrary = (message: string) => assert.deepEqual(changed.splice(0), [["personal", "alias"]], message);

await result(currentCommand, current);
changedLibrary("Only configured sources bound to the current physical and logical library become dirty");
await result(command(...args, "--name", "作者's name", "--description", "", "--max-requests", "100", "--max-bytes=4096", "--timeout", "1000"), current);
changedLibrary("All current singleton metadata/budget flags preserve the exact import owner");
await result(command(...args, "--native", "SKILL.md", "--native=references/guide [literal].md"), current);
changedLibrary("Distinct repeatable native paths retain the current import owner without reading its input");
await result(command(...args, "--native=SKILL.md", "--native", "references/guide.md", "--resume"), { ...current, status: "unchanged" });
changedLibrary("Native imports preserve the same-intent resume visibility boundary");
for (const flags of [
  ["--max-requests", "+100", "--max-bytes=1e3", "--timeout", "100.0"],
  ["--max-requests=.1e3", "--max-bytes", "1E+3", "--timeout=1000e-1"],
  ["--no-dry-run"], ["--no-resume"], ["--resume=false"],
]) {
  await result(command(...args, ...flags), current);
  changedLibrary("The current parser's equivalent integer and false Boolean forms still own one apply");
}
for (const literal of ["true", "yes", "on", "1", "y"]) {
  for (const flag of [["--resume=" + literal], ["--resume", literal]]) {
    await result(command(...args, ...flag), { ...current, status: "unchanged" });
    changedLibrary("Every current true Boolean form retains resume visibility semantics");
  }
}
for (const literal of ["false", "no", "off", "0", "n"]) {
  for (const flag of [["--dry-run=" + literal], ["--dry-run", literal]]) {
    await result(command(...args, ...flag), current);
    changedLibrary("A parser-recognized false dry-run value is an actual apply, not a preview");
  }
  await result(command(...args, "--resume=" + literal), { ...current, status: "unchanged" });
}
assert.deepEqual(changed.splice(0), [], "False resume forms cannot turn an ordinary no-op into a recovery refresh");
for (const cmd of [
  command(...args, "--"),
  command("ctl", "library", "import", "--entry", db, "--skill-id", skill, "--operation", operation, "--", "--literal-directory"),
]) {
  await result(cmd, current);
  changedLibrary("The current end-of-options delimiter preserves exactly one literal input");
}
await result(command("ctl", "library", "import", "/path with spaces/$(literal)", "--entry=library", "--skill-id=" + skill, "--description=--dry-run"), current);
changedLibrary("Single-quoted literal paths and flag-looking metadata values do not become shell expansion or a dry run");
await result(command("ctl", "library", "import", "/staged", "--entry", db.replaceAll("-", "").toUpperCase(), "--skill-id", skill), current);
changedLibrary("Physical UUID spelling is normalized without inferring a name");
for (const entry of entryUrls) {
  await result(atEntry(entry), current);
  changedLibrary("A current Notion URL selects the same exact physical entry as the configured UUID");
}
await result(command("ctl", "library", "import", "/staged", "--entry", otherDb, "--skill-id", "new-skill"), {
  ...current, skill_id: "new-skill", page_id: "11111111-1111-4111-8111-111111111112", library: { ...library, library_id: "other-library", database_id: otherDb },
});
assert.deepEqual(changed.splice(0), [["second"]], "A first import can invalidate an exact configured database without a prior record");

for (const cmd of [
  command("list", "--entry", db), command("read", "skill://entry/SKILL.md"),
  command("create", "/staged", "--database", db), command("apply", "/staged", "--database", db),
  command("replace", "/staged"), command("write", page), command("update", page),
  command("ctl", "sync", "local", "run", "binding"), command("ctl", "sync", "upstream", "run"),
  command("ctl", "operation", "resume", operation), command("ctl", "ctl", "library", "import", "/staged"),
  "echo " + currentCommand, "env " + currentCommand, "node /other-cli " + args.map(quote).join(" "),
  currentCommand + " && echo done", currentCommand + "; echo done", currentCommand + " | cat", currentCommand + " > /tmp/output",
  command(...args, "--no-dry-run", "--max-requests=1e2") + " && echo done",
  currentCommand + "\necho done", currentCommand + "\r\necho done", currentCommand + " # comment",
  currentCommand.replace("'/staged'", "$(selector)"), currentCommand.replace("'/staged'", '"$(selector)"'),
  currentCommand.replace("'/staged'", "`selector`"), currentCommand.replace("'/staged'", "'bad\0path'"),
  currentCommand.replace("'/staged'", "'bad\npath'"), command(...args, "--dry-run"),
  command(...args, "--help"), command(...args, "--progress"), command(...args, "--unknown", "value"),
  command(...args, "--entry=" + db), command(...args, "--skill-id", skill), command(...args, "--operation=" + operation),
  command(...args, "--name", "one", "--name=two"), command(...args, "--description", "one", "--description=two"),
  command(...args, "--native", ""), command(...args, "--native="), command(...args, "--native"),
  command(...args, "--native", "--resume"), command(...args, "--native=SKILL.md", "--native", "SKILL.md"),
  command(...args, "--max-requests", "1", "--max-requests=2"), command(...args, "--max-bytes", "0"),
  command(...args, "--max-requests=-1"), command(...args, "--timeout=1.2"), command(...args, "--timeout=1s"),
  command(...args, "--max-requests=0x64"), command(...args, "--timeout=1e999"), command(...args, "--timeout= 100 "),
  command(...args, "--max-bytes=100."), command(...args, "--timeout=100+100"),
  command(...args, "--max-bytes=9007199254740992"), command(...args, "extra-input"), command(...args, "--resume", "--resume"),
  command(...args, "--", "extra-input"), command(...args, "--", "--resume"),
  command(...args, "--resume=true", "--no-resume"), command(...args, "--no-resume", "--resume=false"),
  command(...args, "--dry-run=false", "--no-dry-run"), command(...args, "--no-dry-run", "--dry-run", "false"),
  command(...args, "--no-resume=false"), command(...args, "--no-resume", "false"),
  command(...args, "--no-dry-run=true"), command(...args, "--no-dry-run", "true"),
  command(...args, "--resume=True"), command(...args, "--dry-run=maybe"),
  ...["true", "yes", "on", "1", "y"].flatMap(value => [command(...args, "--dry-run=" + value), command(...args, "--dry-run", value)]),
  command("ctl", "library", "import", "/staged", "--entry", db, "--skill-id", skill, "--resume"),
  command("ctl", "library", "import", "/staged", "--entry", db, "--skill-id", skill, "--resume=yes"),
  command("ctl", "library", "import", "/staged", "--skill-id", skill),
  command("ctl", "library", "import", "/staged", "--entry", db),
  command("ctl", "library", "import", "--entry", db, "--skill-id", skill),
  command("ctl", "library", "import", "/staged", "--entry", db, "--skill-id", "../bad"),
  command("ctl", "library", "import", "/staged", "--entry", db, "--skill-id", skill, "--operation", "../bad"),
  command("ctl", "library", "import", "/staged", "--entry", "visible-name", "--skill-id", skill),
  command("ctl", "library", "import", "/staged", "--entry", "unregistered-alias", "--skill-id", skill),
  command("ctl", "library", "import", "/staged", "--entry", otherDb, "--skill-id", skill),
]) await result(cmd, current);
assert.deepEqual(changed.splice(0), [], "Reads, retired routes, shell constructs, unknown/duplicate flags and unowned entries are inert");

for (const value of [
  { ...current, contract: "other" }, { ...current, state: "partial" }, { ...current, status: "unknown" },
  { ...current, dry_run: true }, { ...current, ok: false }, { ...current, skill_id: "other-skill" },
  { ...current, operation_id: "other-operation" }, { ...current, operation_id: "../bad" }, { ...current, operation_id: undefined },
  { ...current, input_sha256: "bad" }, { ...current, files: 0 }, { ...current, files: 1.5 },
  { ...current, page_id: skill }, { ...current, page_id: "11111111-1111-4111-8111-111111111112" },
  { ...current, library: undefined }, { ...current, library: { ...library, library_id: "../bad" } },
  { ...current, library: { ...library, library_id: "another-library" } },
  { ...current, library: { ...library, database_id: otherDb } },
  { ...current, library: { ...library, data_source_id: "33333333-3333-4333-8333-333333333334" } },
  { ok: true, verified: true, operation: "replace", action: "update", reused: false, record: records[0], scope: "b".repeat(64) },
]) await result(currentCommand, value);
assert.deepEqual(changed.splice(0), [], "Malformed or mismatched current identities cannot borrow an old receipt or configured name");
await result(currentCommand, { ...current, status: "unchanged" });
assert.deepEqual(changed.splice(0), [], "An ordinary exact re-import has no semantic change to invalidate");
await result(command(...args, "--resume"), { ...current, status: "unchanged" });
changedLibrary("Resume can recover visibility of an earlier write even when reconciliation now reports unchanged");
await result(currentCommand, current, true);
changedLibrary("A valid applied current result still requests a reread when the host reports an error; the observer does not change that result");

const pending = { ok: false, error: { code: "CURRENT_WRITE_OUTCOME_UNKNOWN", details: { operation_id: operation, skill_id: skill } } };
for (const entry of entryUrls) {
  await result(atEntry(entry), pending, true);
  changedLibrary("A partial operation selected by Notion URL still invalidates its exact configured database");
}
for (const isError of [false, true]) {
  await result(currentCommand, pending, isError);
  changedLibrary("Unknown operation context invalidates the exact entry even for host isError");
}
await result(command("ctl", "library", "import", "/staged", "--entry", "library", "--skill-id", skill), pending, true);
changedLibrary("An automatically allocated operation can invalidate its exact configured alias");
for (const value of [
  { ok: false, error: { code: "INVALID_ARGUMENT" } },
  { ok: false, error: { code: "CURRENT_WRITE_OUTCOME_UNKNOWN", details: { skill_id: skill } } },
  { ok: false, error: { details: { operation_id: "../bad", skill_id: skill } } },
  { ok: false, error: { details: { operation_id: "other-operation", skill_id: skill } } },
  { ok: false, error: { details: { operation_id: operation, skill_id: "other-skill" } } },
  { ok: false, details: { operation_id: operation, skill_id: skill } },
]) await result(currentCommand, value, true);
await result(command("ctl", "library", "import", "/staged", "--entry", "unregistered-alias", "--skill-id", skill), pending, true);
assert.deepEqual(changed.splice(0), [], "Local preflight failures and mismatched operation context do not invalidate a directory");

const sqliteWarning = "(node:7778) ExperimentalWarning: SQLite is an experimental feature and might change at any time";
const sqliteHint = "(Use `node --trace-warnings ...` to show where the warning was created)";
const jsonl = (...lines: unknown[]) => lines.map(line => typeof line === "string" ? line : JSON.stringify(line)).join("\n");
for (const output of [JSON.stringify(current, null, 2), jsonl(sqliteWarning, sqliteHint, current), jsonl(current, sqliteWarning, sqliteHint), jsonl(sqliteWarning, JSON.stringify(current, null, 2))]) {
  assert.deepEqual(decodeCliWriteOutput(output), { status: "complete", result: current });
  await result(currentCommand, output);
  changedLibrary("One complete current JSON object survives only the exact observed SQLite warning");
}
const progress = { operation_id: operation, stage: "write", status: "completed", elapsed_ms: 1, stage_ms: 1 };
for (const output of [
  "", "truncated {\"ok\":true", JSON.stringify([current]), jsonl(current, current), jsonl(progress, current),
  jsonl({ other: true }, current), jsonl("unexpected text", current), jsonl(sqliteHint, current),
  jsonl("(node:7778) ExperimentalWarning: Another experimental feature", current),
  jsonl(sqliteWarning, "unexpected text", sqliteHint, current), jsonl(sqliteWarning, current, sqliteHint),
]) {
  assert.equal(decodeCliWriteOutput(output).status, "invalid");
  await result(currentCommand, output);
}
assert.deepEqual(changed.splice(0), [], "Noise, progress, extra JSON and unowned warning hints are rejected");

const marker = "\n\n[Some lines truncated to 768 bytes. Use artifact://1:raw:1-1 to read line 1 whole]";
const truncated = '{"ok":true,"contract":"current",…' + marker;
assert.deepEqual(decodeCliWriteOutput(truncated), { status: "truncated" });
for (const entry of entryUrls) {
  await result(atEntry(entry), truncated);
  changedLibrary("A real host truncation with a current Notion URL permits only the same conservative reread");
}
for (const entry of [
  "https://www.notion.so/" + otherDb.replaceAll("-", ""),
  "https://www.notion.so.evil.example/" + db.replaceAll("-", ""),
  "https://evil.example/https://notion.so/" + db.replaceAll("-", ""),
  "https://notion.so@evil.example/" + db.replaceAll("-", ""),
  "https://notion.so/not-a-page?entry=" + db.replaceAll("-", ""),
  "https://notion.so/not-a-page#" + db.replaceAll("-", ""),
  "https://notion.so/" + db.replaceAll("-", "") + "/child",
  "ftp://notion.so/" + db.replaceAll("-", ""),
  "text-with-" + db.replaceAll("-", "") + "-inside",
  "notion_page:" + db,
]) {
  await result(atEntry(entry), current);
  assert.deepEqual(changed.splice(0), [], "A foreign or invalid URL cannot borrow a successful result's database");
  await result(atEntry(entry), pending, true);
  await result(atEntry(entry), truncated);
  assert.deepEqual(changed.splice(0), entry === "https://www.notion.so/" + otherDb.replaceAll("-", "") ? [["second"], ["second"]] : [],
    "Errors and truncation can affect only the actual URL entry, never another result's database or an embedded ID");
}
for (const embedded of [
  { ...current, status: "unchanged", input: { description: marker } },
  { ok: false, error: { message: marker } },
  { ok: true, authored: '{"ok":true,"contract":"current",…' + marker },
]) {
  assert.deepEqual(decodeCliWriteOutput(JSON.stringify(embedded)), { status: "complete", result: embedded });
  await result(currentCommand, embedded);
}
assert.deepEqual(changed.splice(0), [], "A host-looking marker embedded in any valid JSON content never becomes truncation or success");
for (const output of [truncated.replace("Some lines truncated", "Output truncated"), truncated.replace("…", "..."), jsonl(progress, truncated), jsonl(current, truncated), JSON.stringify(current) + marker, '{"authored":true,…' + marker]) {
  assert.equal(decodeCliWriteOutput(output).status, "invalid");
  await result(currentCommand, output);
}
await result(command("ctl", "library", "import", "/staged", "--entry", "unregistered-alias", "--skill-id", skill), truncated);
assert.deepEqual(changed.splice(0), [], "Only the observed host footer on one current call and an attributable entry permits a conservative reread");
await emit("tool_call", { toolName: "bash", toolCallId: "long", input: { command: currentCommand } });
await emit("tool_result", { toolName: "bash", toolCallId: "long", input: {}, content: truncated, isError: true });
changedLibrary("Host truncation conservatively invalidates once without declaring the write completed");
await emit("tool_result", { toolName: "bash", toolCallId: "long", input: {}, content: JSON.stringify(current) });
await emit("tool_call", { toolName: "read", toolCallId: "artifact", input: { path: "artifact://1:raw:1-1" } });
await emit("tool_result", { toolName: "read", toolCallId: "artifact", input: {}, content: JSON.stringify(current) });
assert.deepEqual(changed.splice(0), [], "There is no artifact follow-up or second trigger after a truncated result");

const call = { toolName: "bash", toolCallId: "owned", input: { command: currentCommand } };
const finish = { toolName: "bash", toolCallId: "owned", input: {}, content: JSON.stringify(current) };
await emit("tool_call", call);
await emit("tool_call", call);
await emit("tool_result", finish, otherCtx);
await emit("tool_result", { ...finish, toolName: "read" });
assert.deepEqual(changed.splice(0), [], "Another session or tool cannot take a pending bash result owner");
await emit("tool_result", finish);
changedLibrary("The original session and tool retain their one pending current call");
await emit("tool_result", finish);
await emit("tool_call", call);
await emit("tool_result", finish);
assert.deepEqual(changed.splice(0), [], "Duplicated call and result events never trigger twice");
await result(currentCommand, current, false, {});
assert.deepEqual(changed.splice(0), [], "Missing session identity cannot own a write result");
await emit("tool_call", { ...call, toolCallId: "replaced" });
await emit("tool_call", { ...call, toolCallId: "replaced", input: { command: command("list") } });
await emit("tool_result", { ...finish, toolCallId: "replaced" });
await emit("tool_call", { ...call, toolCallId: "wrong-input" });
await emit("tool_result", { ...finish, toolCallId: "wrong-input", input: { command: command("list") } });
assert.deepEqual(changed.splice(0), [], "A reused call ID or mismatched host input cannot replace the original command owner");
for (const event of ["session_shutdown", "session_switch", "session_tree", "session_branch"]) {
  const toolCallId = "boundary-" + event;
  await emit("tool_call", { ...call, toolCallId });
  await emit(event, {});
  await emit("tool_result", { ...finish, toolCallId });
}
assert.deepEqual(changed.splice(0), [], "Every session boundary discards late result ownership");

const managedSource = "git-repository", sourcePage = "44444444-4444-4444-8444-444444444444", sourceTable = "55555555-5555-4555-8555-555555555555";
const secondSkill = "skill:two", secondPage = "11111111-1111-4111-8111-111111111112";
const { ok: _targetOk, ...firstTarget } = current;
const sourceTargets = [{ ...firstTarget, operation_id: "source-target:first" },
  { ...firstTarget, skill_id: secondSkill, page_id: secondPage, operation_id: "source-target:second" }];
const sourceCurrent = { ok: true, version: 1, contract: "current", status: "applied", state: "ready", library,
  source_id: managedSource, source_page_id: sourcePage, sources_data_source_id: sourceTable, operation_id: operation,
  input_sha256: "c".repeat(64), configuration_sha256: "d".repeat(64), revision: "e".repeat(64), resolved_commit: "f".repeat(40),
  affected_skill_ids: [skill, secondSkill], targets: sourceTargets };
const sourceUnchanged = { ...sourceCurrent, status: "unchanged", targets: sourceTargets.map(target => ({ ...target, status: "unchanged" })) };
const sourceDetails = { operation_id: operation, owner: { kind: "source", id: managedSource }, source_id: managedSource,
  input_sha256: sourceCurrent.input_sha256, next: "reconcile_current" };
const sourcePending = { ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN", details: sourceDetails } };
const sourceArgs = (route: "apply" | "refresh", entry = db) => ["ctl", "library", "source", route,
  route === "apply" ? "/not-opened/source.json" : managedSource, "--entry", entry, "--operation", operation];
for (const route of ["apply", "refresh"] as const) {
  const sourceCommand = command(...sourceArgs(route));
  await result(sourceCommand, sourceCurrent);
  changedLibrary("One Source operation with two exact targets invalidates the library once, not once per Skill");
  await result(command(...sourceArgs(route), "--no-dry-run", "--resume=false", "--max-requests=1e2", "--timeout", "1000"), sourceCurrent);
  changedLibrary("Source routes preserve the same literal Boolean and bounded integer forms");
  await result(sourceCommand, sourceUnchanged);
  assert.deepEqual(changed.splice(0), [], "An ordinary unchanged Source intent does not invalidate");
  await result(command(...sourceArgs(route), "--resume=true"), sourceUnchanged);
  changedLibrary("A same-intent Source resume recovers earlier visibility");
  await result(sourceCommand, sourcePending, true);
  changedLibrary("An unknown Source parent operation requests a reread without claiming completion");
  await result(sourceCommand, truncated, true);
  changedLibrary("Actual host truncation of an owned Source command conservatively dirties only its entry");
  for (const entry of entryUrls) {
    await result(command(...sourceArgs(route, entry)), sourceCurrent);
    changedLibrary("Source success uses the exact configured Notion URL library");
  }
  for (const cmd of [
    command(...sourceArgs(route), "--dry-run"), command(...sourceArgs(route), "--dry-run=yes"),
    command(...sourceArgs(route), "--entry", db), command(...sourceArgs(route), "--operation", operation),
    command(...sourceArgs(route), "--skill-id", skill), command(...sourceArgs(route), "--name", "visible"),
    command(...sourceArgs(route), "--description", "metadata"), command(...sourceArgs(route), "--unknown"),
    command(...sourceArgs(route), "--native", "SKILL.md"), command(...sourceArgs(route), "--native=SKILL.md"),
    command(...sourceArgs(route), "--timeout", "0"), command(...sourceArgs(route), "extra"),
    sourceCommand + " && echo done", sourceCommand + " | cat",
    command("ctl", "library", "source", route, route === "apply" ? "/source.json" : managedSource, "--entry", db, "--resume"),
  ]) await result(cmd, sourceCurrent);
  assert.deepEqual(changed.splice(0), [], "Source previews, import-only flags, duplicate inputs and shell compounds cannot own a write");
  for (const output of [current, { ...sourceCurrent, state: "pending" }, { ...sourceCurrent, source_page_id: page },
    { ...sourceCurrent, source_id: "source-plan-retired" }, { ...sourceCurrent, resolved_commit: "bad" },
    { ...sourceCurrent, revision: "bad" }, { ...sourceCurrent, configuration_sha256: "bad" },
    { ...sourceCurrent, operation_id: "another-parent" }, { ...sourceCurrent, affected_skill_ids: [skill] },
    { ...sourceCurrent, affected_skill_ids: [skill, skill] }, { ...sourceCurrent, targets: [sourceTargets[0], sourceTargets[0]] },
    { ...sourceCurrent, targets: [sourceTargets[0], { ...sourceTargets[1], page_id: page }] },
    { ...sourceCurrent, targets: [{ ...sourceTargets[0], page_id: secondPage }, { ...sourceTargets[1], page_id: "11111111-1111-4111-8111-111111111113" }] },
    { ...sourceCurrent, targets: [sourceTargets[0], { ...sourceTargets[1], library: { ...library, database_id: otherDb } }] },
    { ...sourceCurrent, targets: [sourceTargets[0], { ...sourceTargets[1], state: "pending" }] },
    { ...sourceCurrent, status: "unchanged" },
  ]) await result(sourceCommand, output);
  assert.deepEqual(changed.splice(0), [], "A Source result must independently bind its current owner and every exact affected Skill");
  for (const details of [
    { ...sourceDetails, owner: { kind: "skill", id: skill }, skill_id: skill },
    { ...sourceDetails, owner: { kind: "source", id: "another-source" } },
    { ...sourceDetails, operation_id: "source-target:first" }, { ...sourceDetails, input_sha256: undefined },
    { ...sourceDetails, next: undefined },
  ]) await result(sourceCommand, { ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN", details } }, true);
  assert.deepEqual(changed.splice(0), [], "A child result or incomplete finite parent cannot borrow the Source invocation");
  for (const output of [sourceCurrent, sourcePending, truncated])
    await result(command(...sourceArgs(route, "unregistered-alias")), output, true);
  assert.deepEqual(changed.splice(0), [], "Source writes do not infer an unregistered CLI alias from a returned library");
}
for (const id of ["../bad", "git:repository", "snapshot-old", "bundle-old", "source-plan-old", "source-" + "a".repeat(64)])
  await result(command("ctl", "library", "source", "refresh", id, "--entry", db, "--operation", operation), { ...sourceCurrent, source_id: id });
await result(command("ctl", "library", "source", "refresh", "another-source", "--entry", db, "--operation", operation), sourceCurrent);
await result(command("ctl", "library", "source", "refresh", "another-source", "--entry", db, "--operation", operation), sourcePending, true);
await result(currentCommand, sourceCurrent);
assert.deepEqual(changed.splice(0), [], "Source identities follow current Source grammar and never become Skill or legacy owners");
await result(command("ctl", "library", "source", "apply", "--entry", db, "--operation", operation, "--", "--literal-source.json"), sourceCurrent);
changedLibrary("A Source declaration filename after the delimiter remains one literal input and is never opened by the observer");
await result(command("ctl", "library", "source", "apply", "/source.json", "--entry", "library"), sourcePending, true);
changedLibrary("An automatically allocated finite Source parent can invalidate the exact configured alias");
const otherLibrary = { library_id: "new-library", database_id: otherDb, data_source_id: "33333333-3333-4333-8333-333333333334" };
await result(command(...sourceArgs("apply", otherDb)), { ...sourceCurrent, library: otherLibrary, affected_skill_ids: ["new-skill"],
  targets: [{ ...sourceTargets[0], skill_id: "new-skill", library: otherLibrary }] });
assert.deepEqual(changed.splice(0), [["second"]], "A first Source write can invalidate an exact database before any Skill is cached");
const sourceCall = { toolName: "bash", toolCallId: "source-owned", input: { command: command(...sourceArgs("refresh")) } };
await emit("tool_call", sourceCall);
await emit("tool_call", sourceCall);
await emit("tool_result", { ...sourceCall, content: JSON.stringify(sourceCurrent) }, otherCtx);
assert.deepEqual(changed.splice(0), [], "A different session cannot consume a Source result");
await emit("tool_result", { ...sourceCall, content: JSON.stringify(sourceCurrent) });
changedLibrary("The original Source invocation invalidates exactly once");
await emit("tool_result", { ...sourceCall, content: JSON.stringify(sourceCurrent) });
assert.deepEqual(changed.splice(0), [], "Repeated Source results cannot invalidate twice");

records = [record("alias", { type: "notion_page", page_id: page, database_id: db, data_source_id: ds })];
await result(currentCommand, current);
assert.deepEqual(changed.splice(0), [["personal"]], "Old page locators cannot bind a configured alias to the current library");
await result(command("ctl", "library", "import", "/staged", "--entry", "library", "--skill-id", skill), pending, true);
assert.deepEqual(changed.splice(0), [["alias"]], "An exact configured alias can still be invalidated without inventing an unknown physical binding");
records = [record("alias", { type: "shared_skill", ...library, skill_id: skill, page_id: page }), record("alias", { type: "shared_skill", ...library, skill_id: skill, page_id: "11111111-1111-4111-8111-111111111112" })];
await result(command("ctl", "library", "import", "/staged", "--entry", "library", "--skill-id", skill), current);
await result(command("ctl", "library", "import", "/staged", "--entry", "library", "--skill-id", skill), pending, true);
assert.deepEqual(changed.splice(0), [], "Conflicting current page ownership cannot authorize an alias or another source");
assert.equal(runtime.calls.length, 0, "The observer executes no CLI or SDK calls and never injects content");
console.log("Current CLI import and Source invalidation checks passed");
