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
const operation = "import:current-1", skill = "skill-one", library = { library_id: db, database_id: "44444444-4444-4444-8444-444444444444", data_source_id: ds };
const rootUrl = "https://www.notion.so/" + db.replaceAll("-", "");
const prefix = hostCliScope().command;
const quote = (word: string) => "'" + word.replaceAll("'", "'\\''") + "'";
const command = (...args: string[]) => [...prefix, ...args].map(quote).join(" ");
const args = ["ctl", "library", "import", "/staged", "--library", db, "--skill-id", skill, "--operation", operation];
const currentCommand = command(...args);
const atEntry = (entry: string) => command("ctl", "library", "import", "/staged", "--library", entry, "--skill-id", skill, "--operation", operation);
const entryUrls = [
  "https://www.notion.so/Library-" + db.replaceAll("-", "") + "?v=ignored",
  "https://app.notion.com/p/team/library-" + db.replaceAll("-", "") + "?source=copy_link",
  "https://team.notion.site/" + db.replaceAll("-", "").toUpperCase() + "/#section",
];
const current = { ok: true, contract: "current", status: "applied", operation_id: operation, skill_id: skill, page_id: page,
  input_sha256: "a".repeat(64), files: 3, state: "ready", library };
const sources: SourceConfig[] = [
  { id: "personal", type: "notion", library: db },
  { id: "second", type: "notion", library: otherDb },
  { id: "alias", type: "notion", library: rootUrl },
  { id: "disabled", type: "notion", library: db, enabled: false },
  { id: "unbound", type: "notion" },
];
function record(sourceId: string, locator: ContentRecord["locator"] = { type: "shared_skill", ...library, skill_id: skill, page_id: page }): SkillRecord {
  return { id: "skill://skill-one?library=" + db, kind: "skill", name: "visible name", alias: "visible-name", description: "Current item",
    default_context: false, enabled: true, entrypoint: "SKILL.md", ref: "skill://skill-one/SKILL.md?library=" + db,
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
  command("ctl", "library", "import", "--library", db, "--skill-id", skill, "--operation", operation, "--", "--literal-directory"),
]) {
  await result(cmd, current);
  changedLibrary("The current end-of-options delimiter preserves exactly one literal input");
}
await result(command("ctl", "library", "import", "/path with spaces/$(literal)", "--library=" + rootUrl, "--skill-id=" + skill, "--description=--dry-run"), current);
changedLibrary("Single-quoted literal paths and flag-looking metadata values do not become shell expansion or a dry run");
await result(command("ctl", "library", "import", "/staged", "--library", db.replaceAll("-", "").toUpperCase(), "--skill-id", skill), current);
changedLibrary("Physical UUID spelling is normalized without inferring a name");
for (const entry of entryUrls) {
  await result(atEntry(entry), current);
  changedLibrary("A current Notion URL selects the same exact physical entry as the configured UUID");
}
await result(command("ctl", "library", "import", "/staged", "--library", otherDb, "--skill-id", "new-skill"), {
  ...current, skill_id: "new-skill", page_id: "11111111-1111-4111-8111-111111111112", library: { ...library, library_id: otherDb, database_id: otherDb },
});
assert.deepEqual(changed.splice(0), [["second"]], "A first import can invalidate an exact configured database without a prior record");

for (const cmd of [
  command("list", "--library", db), command("read", "skill://entry/SKILL.md"),
  command("create", "/staged", "--library", db), command("apply", "/staged", "--library", db),
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
  command(...args, "--library=" + db), command(...args, "--skill-id", skill), command(...args, "--operation=" + operation),
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
  command("ctl", "library", "import", "/staged", "--library", db, "--skill-id", skill, "--resume"),
  command("ctl", "library", "import", "/staged", "--library", db, "--skill-id", skill, "--resume=yes"),
  command("ctl", "library", "import", "/staged", "--skill-id", skill),
  command("ctl", "library", "import", "/staged", "--library", db),
  command("ctl", "library", "import", "--library", db, "--skill-id", skill),
  command("ctl", "library", "import", "/staged", "--library", db, "--skill-id", "../bad"),
  command("ctl", "library", "import", "/staged", "--library", db, "--skill-id", skill, "--operation", "../bad"),
  command("ctl", "library", "import", "/staged", "--library", "visible-name", "--skill-id", skill),
  command("ctl", "library", "import", "/staged", "--library", "unregistered-alias", "--skill-id", skill),
  command("ctl", "library", "import", "/staged", "--library", otherDb, "--skill-id", skill),
]) await result(cmd, current);
assert.deepEqual(changed.splice(0), [], "Reads, retired routes, shell constructs, unknown/duplicate flags and unowned entries are inert");

for (const value of [
  { ...current, contract: "other" }, { ...current, state: "partial" }, { ...current, status: "unknown" },
  { ...current, dry_run: true }, { ...current, ok: false }, { ...current, skill_id: "other-skill" },
  { ...current, operation_id: "other-operation" }, { ...current, operation_id: "../bad" }, { ...current, operation_id: undefined },
  { ...current, input_sha256: "bad" }, { ...current, files: 0 }, { ...current, files: 1.5 },
  { ...current, page_id: skill },
  { ...current, library: undefined }, { ...current, library: { ...library, library_id: "../bad" } },
  { ...current, library: { ...library, library_id: "8b308dab-2daf-5330-922f-812244ff16f9" } },
  { ...current, library: { ...library, database_id: otherDb } },
  { ...current, library: { ...library, data_source_id: "33333333-3333-4333-8333-333333333334" } },
  { ok: true, verified: true, operation: "replace", action: "update", reused: false, record: records[0], scope: "b".repeat(64) },
]) await result(currentCommand, value);
assert.deepEqual(changed.splice(0), [], "Malformed or mismatched current identities cannot borrow an old receipt or configured name");
await result(currentCommand, { ...current, page_id: "11111111-1111-4111-8111-111111111119" });
changedLibrary("Recreating a deleted Skill under the same stable identity invalidates its old physical-page cache");
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
await result(command("ctl", "library", "import", "/staged", "--library", rootUrl, "--skill-id", skill), pending, true);
changedLibrary("An automatically allocated operation can invalidate its exact configured alias");
for (const value of [
  { ok: false, error: { code: "INVALID_ARGUMENT" } },
  { ok: false, error: { code: "CURRENT_WRITE_OUTCOME_UNKNOWN", details: { skill_id: skill } } },
  { ok: false, error: { details: { operation_id: "../bad", skill_id: skill } } },
  { ok: false, error: { details: { operation_id: "other-operation", skill_id: skill } } },
  { ok: false, error: { details: { operation_id: operation, skill_id: "other-skill" } } },
  { ok: false, details: { operation_id: operation, skill_id: skill } },
]) await result(currentCommand, value, true);
await result(command("ctl", "library", "import", "/staged", "--library", "unregistered-alias", "--skill-id", skill), pending, true);
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
await result(command("ctl", "library", "import", "/staged", "--library", "unregistered-alias", "--skill-id", skill), truncated);
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
const sourceCurrent = { ok: true, version: 1, contract: "current", action: "declaration", status: "applied", state: "ready", library,
  source_id: managedSource, source_page_id: sourcePage, sources_data_source_id: sourceTable, operation_id: operation,
  input_sha256: "c".repeat(64), configuration_sha256: "d".repeat(64), revision: "e".repeat(64), resolved_commit: "f".repeat(40),
  affected_skill_ids: [skill, secondSkill], targets: sourceTargets };
const sourceUnchanged = { ...sourceCurrent, status: "unchanged", targets: sourceTargets.map(target => ({ ...target, status: "unchanged" })) };
const sourceDetails = { operation_id: operation, owner: { kind: "source", id: managedSource }, source_id: managedSource,
  input_sha256: sourceCurrent.input_sha256, next: "reconcile_current" };
const sourcePending = { ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN", details: sourceDetails } };
const sourceArgs = (route: "apply" | "refresh", entry = db) => ["ctl", "library", "source", route,
  route === "apply" ? "/not-opened/source.json" : managedSource, "--library", entry, "--operation", operation];
for (const route of ["apply", "refresh"] as const) {
  const sourceCommand = command(...sourceArgs(route));
  await result(sourceCommand, sourceCurrent);
  changedLibrary("One Source operation with two exact targets invalidates the library once, not once per Skill");
  await result(sourceCommand, { ...sourceCurrent, targets: [
    { ...sourceTargets[0], page_id: "11111111-1111-4111-8111-111111111113" }, sourceTargets[1],
  ] });
  changedLibrary("A rebuilt Source member triggers discovery even when its old page is cached");
  const removedTarget = { ...sourceTargets[0], status: "removed", state: "removed", files: 0 };
  await result(sourceCommand, { ...sourceCurrent, targets: [removedTarget, sourceTargets[1]] });
  changedLibrary("A synchronized upstream deletion invalidates the library with the complete affected member set");
  await result(sourceCommand, { ...sourceCurrent, targets: sourceTargets.map(target => ({
    ...target, status: "removed", state: "removed", files: 0,
  })) });
  changedLibrary("A complete empty upstream selection retires every member and invalidates once");
  for (const invalidTarget of [
    { ...removedTarget, files: 1 }, { ...removedTarget, status: "applied" },
    { ...removedTarget, state: "ready" }, { ...removedTarget, page_id: managedSource },
    { ...removedTarget, input_sha256: "bad" }, { ...removedTarget, operation_id: "../bad" },
    { ...removedTarget, library: { ...library, database_id: otherDb } },
  ]) await result(sourceCommand, { ...sourceCurrent, targets: [invalidTarget, sourceTargets[1]] });
  await result(sourceCommand, { ...sourceUnchanged, targets: [removedTarget, sourceUnchanged.targets[1]] });
  assert.deepEqual(changed.splice(0), [], "A retirement must prove removed state, zero remaining files and exact current scope; it cannot be an unchanged result");
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
    command(...sourceArgs(route), "--library", db), command(...sourceArgs(route), "--operation", operation),
    command(...sourceArgs(route), "--skill-id", skill), command(...sourceArgs(route), "--name", "visible"),
    command(...sourceArgs(route), "--description", "metadata"), command(...sourceArgs(route), "--unknown"),
    command(...sourceArgs(route), "--native", "SKILL.md"), command(...sourceArgs(route), "--native=SKILL.md"),
    command(...sourceArgs(route), "--timeout", "0"), command(...sourceArgs(route), "extra"),
    sourceCommand + " && echo done", sourceCommand + " | cat",
    command("ctl", "library", "source", route, route === "apply" ? "/source.json" : managedSource, "--library", db, "--resume"),
  ]) await result(cmd, sourceCurrent);
  assert.deepEqual(changed.splice(0), [], "Source previews, import-only flags, duplicate inputs and shell compounds cannot own a write");
  for (const output of [current, { ...sourceCurrent, state: "pending" }, { ...sourceCurrent, source_page_id: page },
    { ...sourceCurrent, source_id: "source-plan-retired" }, { ...sourceCurrent, resolved_commit: "bad" },
    { ...sourceCurrent, revision: "bad" }, { ...sourceCurrent, configuration_sha256: "bad" },
    { ...sourceCurrent, operation_id: "another-parent" }, { ...sourceCurrent, affected_skill_ids: [skill] },
    { ...sourceCurrent, affected_skill_ids: [skill, skill] }, { ...sourceCurrent, targets: [sourceTargets[0], sourceTargets[0]] },
    { ...sourceCurrent, targets: [sourceTargets[0], { ...sourceTargets[1], page_id: page }] },
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
  await result(command("ctl", "library", "source", "refresh", id, "--library", db, "--operation", operation), { ...sourceCurrent, source_id: id });
await result(command("ctl", "library", "source", "refresh", "another-source", "--library", db, "--operation", operation), sourceCurrent);
await result(command("ctl", "library", "source", "refresh", "another-source", "--library", db, "--operation", operation), sourcePending, true);
await result(currentCommand, sourceCurrent);
assert.deepEqual(changed.splice(0), [], "Source identities follow current Source grammar and never become Skill or legacy owners");
await result(command("ctl", "library", "source", "apply", "--library", db, "--operation", operation, "--", "--literal-source.json"), sourceCurrent);
changedLibrary("A Source declaration filename after the delimiter remains one literal input and is never opened by the observer");
await result(command("ctl", "library", "source", "apply", "/source.json", "--library", rootUrl), sourcePending, true);
changedLibrary("An automatically allocated finite Source parent can invalidate the exact configured alias");
const otherLibrary = { library_id: otherDb, database_id: otherDb, data_source_id: "33333333-3333-4333-8333-333333333334" };
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

// New Source actions retain the exact owner but have distinct completion shapes.
const { resolved_commit: _commit, ...sourceBase } = sourceCurrent;
const metadataTargets = sourceTargets.map(target => ({ skill_id: target.skill_id, skill_page_id: target.page_id }));
for (const verb of ["enable", "disable"] as const) {
  const argv = ["ctl", "library", "source", verb, managedSource, "--library", db, "--operation", operation];
  const value = { ...sourceBase, action: "enabled", enabled: verb === "enable", targets: metadataTargets };
  await result(command(...argv), value);
  changedLibrary("Source eligibility changes invalidate current discovery without pretending to rewrite child bodies");
  await result(command(...argv), { ...value, status: "unchanged" });
  assert.deepEqual(changed.splice(0), [], "An unchanged ordinary eligibility request does not invalidate");
  for (const mode of [["--resume"], ["--supersede", "prior-source-intent"]]) {
    await result(command(...argv, ...mode), { ...value, status: "unchanged" });
    changedLibrary("A resumed or explicitly superseded eligibility intent recovers current visibility");
  }
  for (const invalid of [
    { ...value, action: undefined }, { ...value, action: "declaration" },
    { ...value, enabled: verb !== "enable" }, { ...value, enabled: undefined },
    { ...value, targets: sourceTargets }, { ...value, targets: [{ ...metadataTargets[0], state: "ready" }, metadataTargets[1]] },
    { ...value, targets: [{ ...metadataTargets[0], skill_page_id: sourcePage }, metadataTargets[1]] },
    { ...value, affected_skill_ids: [skill, secondSkill, "missing"] },
    { ...value, status: "inspected", remote_writes: 0 }, { ...value, state: "removed" },
    sourceCurrent,
  ]) await result(command(...argv), invalid);
  assert.deepEqual(changed.splice(0), [], "Eligibility results bind the requested Boolean and exact metadata target shape");
  await result(command(...argv), sourcePending, true);
  changedLibrary("An unfinished eligibility action retains its Source parent invalidation scope");
}
const removeArgs = ["ctl", "library", "source", "remove", managedSource, "--library", db, "--operation", operation];
const removed = { ...sourceBase, action: "remove", state: "removed", status: "removed", targets: metadataTargets };
await result(command(...removeArgs), removed);
changedLibrary("Confirmed Source retirement invalidates its exact library");
await result(command(...removeArgs, "--resume"), removed);
changedLibrary("Reconciled retirement remains a removed Source, not a ready Skill");
await result(command(...removeArgs), { ...removed, affected_skill_ids: [], targets: [] });
changedLibrary("An unreferenced Source can be retired with an honestly empty target set");
for (const invalid of [
  { ...removed, state: "ready" }, { ...removed, status: "applied" }, { ...removed, action: "enabled" },
  { ...removed, action: undefined }, { ...removed, targets: sourceTargets }, { ...removed, targets: [] },
  { ...removed, targets: metadataTargets.map(target => ({ skill_id: target.skill_id, page_id: target.skill_page_id })) },
  sourceCurrent,
]) await result(command(...removeArgs), invalid);
assert.deepEqual(changed.splice(0), [], "Only removed completion with complete metadata bindings proves retirement");
await result(command(...removeArgs), sourcePending, true);
changedLibrary("Unknown Source Trash acknowledgement causes a conservative reread, not completion");

const sourcePath = "skills/alpha/guide [literal].md", selectedFile = "file:guide";
for (const verb of ["takeover", "restore-follow"] as const) {
  const argv = ["ctl", "library", "source", verb, managedSource, sourcePath,
    "--library", db, "--operation", operation, "--skill-id", skill, "--file-id", selectedFile];
  const value = { ...sourceBase, action: verb === "takeover" ? "takeover" : "restore_follow",
    file_id: selectedFile, source_path: sourcePath, affected_skill_ids: [skill], targets: [sourceTargets[0]] };
  await result(command(...argv), value);
  changedLibrary("Exact Source file transfers bind one ready target without requiring a fabricated Git discovery result");
  if (verb === "takeover") {
    for (const authority of ["native", "resource"]) {
      await result(command(...argv, "--as=" + authority), value);
      changedLibrary("Explicit current takeover authority retains the same observed target");
    }
  }
  await result(command(...argv, "--resume"), { ...value, status: "unchanged", targets: [{ ...sourceTargets[0], status: "unchanged" }] });
  changedLibrary("File-transfer resume recovers visibility while preserving the exact selected File");
  await result(command(...argv), sourcePending, true);
  changedLibrary("Unknown file transfer remains a finite parent Source error");
  for (const invalid of [
    { ...value, action: "declaration" }, { ...value, action: verb === "takeover" ? "restore_follow" : "takeover" },
    { ...value, file_id: "another-file" }, { ...value, source_path: "skills/other/guide.md" },
    { ...value, targets: metadataTargets.slice(0, 1) }, { ...value, affected_skill_ids: [secondSkill] },
    { ...value, affected_skill_ids: [skill, secondSkill], targets: sourceTargets },
    { ...value, targets: [{ ...sourceTargets[0], state: "pending" }] }, sourceCurrent,
  ]) await result(command(...argv), invalid);
  for (const flags of [["--native", "SKILL.md"], ["--file-id", selectedFile], ["--as", "source"], ["--dry-run"]])
    await result(command(...argv, ...flags), value);
  if (verb === "restore-follow") await result(command(...argv, "--as", "resource"), value);
  for (const path of ["", "../outside", "/absolute", "a//b", "a/./b", "a/../b", "C:/outside", "a\\b"])
    await result(command("ctl", "library", "source", verb, managedSource, path,
      "--library", db, "--operation", operation, "--skill-id", skill, "--file-id", selectedFile), { ...value, source_path: path });
  assert.deepEqual(changed.splice(0), [], "File-transfer outputs and flags cannot substitute another action, path, File or Skill");
}

for (const [argv, value, failure] of [[args, current, pending], [sourceArgs("apply"), sourceCurrent, sourcePending]] as const) {
  const superseded = command(...argv, "--supersede", "predecessor-intent");
  await result(superseded, value);
  changedLibrary("A completed supersede must identify the new current operation");
  const noOp = "targets" in value ? sourceUnchanged : { ...current, status: "unchanged" };
  await result(superseded, noOp);
  changedLibrary("A supersede no-op still refreshes visibility from the explicitly reconciled predecessor");
  await result(superseded, failure, true);
  changedLibrary("An error after supersede handoff uses the new operation context");
  await result(superseded, { ...failure, error: { ...failure.error, details: { ...failure.error.details, operation_id: "predecessor-intent" } } }, true);
  changedLibrary("Before handoff an explicitly named predecessor error permits only conservative invalidation");
  await result(superseded, { ...value, operation_id: "predecessor-intent" });
  for (const flags of [
    ["--supersede", operation], ["--supersede", "predecessor-intent", "--resume"],
    ["--supersede", "predecessor-intent", "--dry-run"], ["--supersede", ""],
    ["--supersede", "bad predecessor"], ["--supersede", "old", "--supersede", "other"],
  ]) await result(command(...argv, ...flags), value);
  assert.deepEqual(changed.splice(0), [], "Predecessor success and ambiguous supersede flags cannot claim the new write");
}
for (const verb of ["enable", "disable", "remove"])
  await result(command("ctl", "library", "source", verb, managedSource, "--library", db, "--supersede", "old"), removed);
assert.deepEqual(changed.splice(0), [], "Source supersede requires an explicit distinct new operation");

// Native Skill management allocates and resumes its own operation; its public
// commands do not accept import/Source recovery flags or share their statuses.
const nativeCreated = { ...current, action: "create", status: "created" };
const nativeUpdated = { ...current, action: "update" };
const nativeRegistered = { ...current, version: 1, action: "register", status: "registered",
  paths: ["SKILL.md", "references/guide.md", "assets/data.bin"] };
const nativeRemoved = { ok: true, version: 1, contract: "current", action: "remove", library,
  operation_id: operation, input_sha256: current.input_sha256, skill_id: skill, page_id: page,
  state: "removed", status: "removed", cleanup_verified: true,
  files: [{ file_id: "guide", page_id: secondPage, path: "references/guide.md", content_sha256: "b".repeat(64) }],
  resources: [{ resource_id: "resource:guide", page_id: sourcePage, payload_sha256: "c".repeat(64) }],
  relations: [{ skill_id: secondSkill, page_id: sourceTable, field: "Requires", before: [page, secondPage], after: [secondPage] }] };
const nativeCases = [
  { action: "create", argv: ["ctl", "library", "skill", "create", "/staged/SKILL.md", "--skill-id", skill, "--library", db], receipt: nativeCreated },
  { action: "update", argv: ["ctl", "library", "skill", "update", page, "--description", "New metadata", "--library", db], receipt: nativeUpdated },
  { action: "register", argv: ["ctl", "library", "skill", "register", page, "--library", db], receipt: nativeRegistered },
  { action: "remove", argv: ["ctl", "library", "skill", "remove", page, "--library", db], receipt: nativeRemoved },
];
for (const { action, argv, receipt } of nativeCases) {
  await result(command(...argv), receipt);
  changedLibrary("A completed native " + action + " invalidates only its exact configured library");
  await result(command(...argv, "--no-dry-run", "--max-requests=1e2", "--max-bytes", "4096", "--timeout=1000"), receipt);
  changedLibrary("Native management retains literal false dry-run and bounded integer options");
  for (const entry of entryUrls) {
    await result(command(...argv.slice(0, -1), entry), receipt);
    changedLibrary("Native writes accept the same exact Notion library URL as the CLI");
  }
  for (const invalid of [
    { ...receipt, action: "other" }, { ...receipt, action: undefined }, { ...receipt, contract: "other" },
    { ...receipt, state: "pending" }, { ...receipt, dry_run: true }, { ...receipt, ok: false },
    { ...receipt, operation_id: undefined }, { ...receipt, operation_id: "../bad" }, { ...receipt, input_sha256: "bad" },
    { ...receipt, page_id: "invalid" }, { ...receipt, skill_id: "../bad" },
    { ...receipt, library: undefined }, { ...receipt, library: { ...library, database_id: otherDb } },
    { ...receipt, library: { ...library, library_id: "8b308dab-2daf-5330-922f-812244ff16f9" } },
    { ...receipt, library: { ...library, data_source_id: sourceTable } },
    current, sourceCurrent,
  ]) await result(command(...argv), invalid);
  for (const flags of [
    ["--dry-run"], ["--dry-run=yes"], ["--dry-run", "true"], ["--library", db],
    ["--operation", operation], ["--resume"], ["--resume=false"], ["--supersede", "old"],
    ["--native", "SKILL.md"], ["--unknown", "value"], ["--max-requests", "0"],
    ["--timeout", "1.5"], ["--timeout", "1", "--timeout=2"], ["extra"],
  ]) await result(command(...argv, ...flags), receipt);
  for (const cmd of ["ntn-skills " + argv.map(quote).join(" "), "env " + command(...argv),
    command(...argv) + " && echo done", command(...argv) + " | cat", command(...argv) + "; echo done"])
    await result(cmd, receipt);
  assert.deepEqual(changed.splice(0), [], "Native actions cannot borrow other receipt kinds, invalid flags, global commands or shell compounds");
  const details = { owner: { kind: "skill", id: skill }, skill_id: skill, skill_page_id: page,
    operation_id: operation, input_sha256: current.input_sha256, next: "reconcile_current" };
  const failure = { ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN", details } };
  await result(command(...argv), failure, true);
  changedLibrary("An exact unfinished native owner permits a conservative reread without claiming completion");
  for (const invalid of [
    { ...details, owner: { kind: "source", id: skill } }, { ...details, owner: { kind: "skill", id: "other" } },
    { ...details, skill_id: undefined }, { ...details, operation_id: undefined }, { ...details, operation_id: "../bad" },
    { ...details, input_sha256: undefined }, { ...details, next: undefined },
  ]) await result(command(...argv), { ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN", details: invalid } }, true);
  await result(command(...argv), { ok: false, error: { code: "INVALID_ARGUMENT" } }, true);
  assert.deepEqual(changed.splice(0), [], "Native preflight errors and incomplete or foreign operation owners are inert");
  await result(command(...argv), truncated, true);
  changedLibrary("Actual host truncation of one scoped native invocation retains conservative reread semantics");
}

await result(command("ctl", "library", "skill", "create", "/new/SKILL.md", "--library", otherDb, "--skill-id", "first-native"),
  { ...nativeCreated, skill_id: "first-native", page_id: secondPage, library: otherLibrary });
assert.deepEqual(changed.splice(0), [["second"]], "First native creation invalidates an exact database before the new Skill is cached");
await result(command("ctl", "library", "skill", "create", "/not-opened/author's input.md", "--library", rootUrl, "--skill-id", skill,
  "--name", "Author name", "--description=", "--enabled", "true", "--default-context=false", "--members", secondSkill, "--requires", ""), nativeCreated);
changedLibrary("Native create preserves explicit metadata and exact repeated relation syntax without opening its input");
await result(command("ctl", "library", "skill", "create", "--library", db, "--skill-id", skill, "--", "--literal-input.md"), nativeCreated);
changedLibrary("Native creation preserves a literal operand after end-of-options");
await result(command("ctl", "library", "skill", "update", skill, "--library", db, "--input", "/local/main.md", "--path", "references/guide.md",
  "--file", "assets/one.bin=/local/one.bin", "--file=assets/two.bin=/local/two.bin", "--remove-file", "references/old.md",
  "--remove-file=assets/old.bin", "--members", secondSkill, "--members", sourcePage, "--requires=", "--enabled=false"), nativeUpdated);
changedLibrary("Native updates accept the current repeated file and relation selections");
for (const target of [page, page.replaceAll("-", "").toUpperCase(), "https://www.notion.so/Owned-" + page.replaceAll("-", "")]) {
  for (const { action, receipt } of nativeCases.filter(value => value.action !== "create")) {
    const argv = ["ctl", "library", "skill", action, target, "--library", db,
      ...(action === "update" ? ["--input", "/local/main.md"] : action === "register" ? ["--skill-id", skill] : [])];
    await result(command(...argv), receipt);
    changedLibrary("An exact native page selector must match the returned physical Skill");
    await result(command(...argv), { ...receipt, page_id: secondPage });
    await result(command(...argv), { ok: false, error: { details: { owner: { kind: "skill", id: skill }, skill_id: skill,
      skill_page_id: secondPage, operation_id: operation, input_sha256: current.input_sha256, next: "reconcile_current" } } }, true);
    assert.deepEqual(changed.splice(0), [], "A receipt or unfinished operation for another page cannot borrow the selected target");
  }
}
for (const { action, receipt } of nativeCases.filter(value => value.action !== "register")) {
  const argv = ["ctl", "library", "skill", action, action === "create" ? "/input.md" : skill, "--library", db,
    ...(action === "create" ? ["--skill-id", skill] : action === "update" ? ["--description", "New metadata"] : [])];
  await result(command(...argv), receipt);
  changedLibrary("A native stable selector binds the exact returned Skill identity");
  await result(command(...argv), { ...receipt, skill_id: secondSkill });
  assert.deepEqual(changed.splice(0), [], "A native stable selector never becomes a display-name match");
}
await result(command("ctl", "library", "skill", "register", page, "--library", db, "--skill-id", secondSkill), nativeRegistered);
assert.deepEqual(changed.splice(0), [], "Explicit registration identity must agree with the returned stable identity");

for (const [argv, receipt] of [
  [nativeCases[0]!.argv, { ok: true, version: 1, contract: "current", action: "create", status: "unchanged", state: "ready",
    skill_id: skill, page_id: page, input_sha256: current.input_sha256, remote_writes: 0 }],
  [nativeCases[1]!.argv, { ...nativeUpdated, status: "unchanged" }],
  [nativeCases[2]!.argv, { ok: true, version: 1, contract: "current", action: "register", status: "unchanged", state: "ready",
    library, skill_id: skill, page_id: page, files: 1, paths: ["SKILL.md"], remote_writes: 0 }],
  [nativeCases[3]!.argv, { ok: true, version: 1, contract: "current", action: "remove", status: "already_trashed", state: "removed",
    library, skill_id: skill, page_id: page, cleanup_verified: false, remote_writes: 0 }],
  [["ctl", "library", "skill", "remove", skill, "--library", db], { ok: true, version: 1, contract: "current", action: "remove",
    library, skill_id: skill, page_id: null, state: "removed", status: "not_found", cleanup_verified: false, remote_writes: 0 }],
] satisfies Array<[string[], Record<string, unknown>]>) await result(command(...argv), receipt);
assert.deepEqual(changed.splice(0), [], "Ordinary native no-ops and externally missing or trashed pages do not claim a new completed write");

for (const { action, argv, receipt } of nativeCases.filter(value => value.action !== "remove")) {
  for (const invalid of [{ ...receipt, files: 0 }, { ...receipt, files: 1.5 }, { ...receipt, files: [] }])
    await result(command(...argv), invalid);
  if (action === "register") for (const invalid of [
    { ...receipt, version: 2 }, { ...receipt, paths: undefined }, { ...receipt, paths: ["SKILL.md"] },
    { ...receipt, paths: ["SKILL.md", "references/guide.md", "references/guide.md"] },
  ]) await result(command(...argv), invalid);
}
for (const invalid of [
  { ...nativeRemoved, version: 2 }, { ...nativeRemoved, cleanup_verified: false },
  { ...nativeRemoved, cleanup_verified: undefined }, { ...nativeRemoved, files: 0 }, { ...nativeRemoved, resources: undefined },
  { ...nativeRemoved, relations: undefined }, { ...nativeRemoved, files: [{ ...nativeRemoved.files[0], page_id: page }] },
  { ...nativeRemoved, files: [{ ...nativeRemoved.files[0], content_sha256: "bad" }] },
  { ...nativeRemoved, files: [nativeRemoved.files[0], nativeRemoved.files[0]] },
  { ...nativeRemoved, resources: [{ ...nativeRemoved.resources[0], page_id: secondPage }] },
  { ...nativeRemoved, resources: [{ ...nativeRemoved.resources[0], payload_sha256: "bad" }] },
  { ...nativeRemoved, relations: [{ ...nativeRemoved.relations[0], field: "Other" }] },
  { ...nativeRemoved, relations: [{ ...nativeRemoved.relations[0], after: [page, secondPage] }] },
  { ...nativeRemoved, relations: [{ ...nativeRemoved.relations[0], before: [secondPage] }] },
  { ...nativeRemoved, relations: [nativeRemoved.relations[0], nativeRemoved.relations[0]] },
]) await result(command(...nativeCases[3]!.argv), invalid);
assert.deepEqual(changed.splice(0), [], "Native completion validates its own file inventory and verified removal coordinates");
await result(command(...nativeCases[3]!.argv), { ...nativeRemoved, files: [], resources: [], relations: [] });
changedLibrary("Removing a native main with no supporting objects or inbound relations has an honestly empty cleanup inventory");

for (const argv of [
  ["create", "/input.md"], ["create", "/input.md", "--skill-id", "../bad"],
  ["create", "/input.md", "--skill-id", skill, "--skill-id", skill],
  ["create", "/input.md", "--skill-id", skill, "--input", "/other.md"],
  ["update", skill], ["update", skill, "--path", "SKILL.md"], ["update", skill, "--file", "malformed"],
  ["update", skill, "--file", "SKILL.md="], ["update", skill, "--file", "=local.md"],
  ["update", skill, "--enabled", "maybe"], ["update", skill, "--default-context", "1"],
  ["update", skill, "--description", "one", "--description", "two"],
  ["update", skill, "--requires", "", "--requires", secondSkill], ["update", skill, "--members", secondSkill, "--members", secondSkill],
  ["register", skill], ["register", page, "--skill-id", "../bad"], ["register", page, "--requires", secondSkill],
  ["remove", page, "--enabled", "false"], ["remove", "https://evil.example/" + page.replaceAll("-", "")],
]) await result(command("ctl", "library", "skill", ...argv, "--library", db), nativeCases.find(value => value.action === argv[0])!.receipt);
assert.deepEqual(changed.splice(0), [], "Native parsing respects each action's actual targets, selected inputs and flag grammar");

records = [record("alias", { type: "notion_page", page_id: page, database_id: db, data_source_id: ds })];
await result(currentCommand, current);
assert.deepEqual(changed.splice(0), [["personal", "alias"]], "Configured root IDs and root URLs bind the same library without requiring a legacy page locator");
await result(command("ctl", "library", "import", "/staged", "--library", rootUrl, "--skill-id", skill), pending, true);
assert.deepEqual(changed.splice(0), [["personal", "alias"]], "An unknown write targets the same configured root independently of its URL spelling");
records = [record("alias", { type: "shared_skill", ...library, skill_id: skill, page_id: page }), record("alias", { type: "shared_skill", ...library, skill_id: skill, page_id: "11111111-1111-4111-8111-111111111112" })];
await result(command("ctl", "library", "import", "/staged", "--library", rootUrl, "--skill-id", skill), current);
await result(command("ctl", "library", "import", "/staged", "--library", rootUrl, "--skill-id", skill), pending, true);
assert.deepEqual(changed.splice(0), [["personal"], ["personal"]], "Conflicting page ownership excludes that Source while an independently configured root still permits metadata invalidation");
assert.equal(runtime.calls.length, 0, "The observer executes no CLI or SDK calls and never injects content");
console.log("Current CLI import, Source and native Skill invalidation checks passed");
