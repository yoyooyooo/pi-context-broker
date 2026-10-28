import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCliWriteOutput, installCliWriteInvalidation } from "../src/cli-write-invalidation";
import contextBroker from "../src/index";
import type { AutocompleteProvider, ExtensionAPI, ExtensionContext, SkillRecord, SourceConfig } from "../src/types";

type Listener = (event: never, ctx: ExtensionContext) => unknown;
const db = "22222222-2222-4222-8222-222222222222", otherDb = "22222222-2222-4222-8222-222222222223";
const page = "11111111-1111-4111-8111-111111111111", ds = "33333333-3333-4333-8333-333333333333", auth = "a".repeat(64);
const locator = { type: "notion_page" as const, page_id: page, database_id: db, data_source_id: ds };
const prefix = ["/tools/node", "/tools with spaces/ntn-skills.mjs"];
const quote = (word: string) => "'" + word.replaceAll("'", "'\\''") + "'";
const command = (...args: string[]) => [...prefix, ...args].map(quote).join(" ");
const sources: SourceConfig[] = [
  { id: "personal", type: "notion", command: prefix, database: db },
  { id: "second", type: "notion", command: prefix, database: otherDb },
  { id: "alias", type: "notion", command: prefix, database: "library" },
  { id: "other-command", type: "notion", command: ["/other/ntn-skills"], database: db },
];
const records = ["personal", "alias"].map(sourceId => ({ sourceId, sourceScope: auth, locator } as SkillRecord));
const receipt = { ok: true, operation: "replace", action: "update", verified: true, reused: false, scope: auth, record: { id: "notion_page:" + page, locator }, snapshot_id: "s_" + "b".repeat(64) };
const listeners = new Map<string, Listener[]>();
const changed: string[][] = [];
const ctx: ExtensionContext = { cwd: "/owned", sessionManager: { getSessionId: () => "write-session" } };
const api: ExtensionAPI = { on(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler as unknown as Listener]); } };
const emit = async (name: string, event: unknown) => { for (const handler of listeners.get(name) ?? []) await handler(event as never, ctx); };
installCliWriteInvalidation(api, { sources, records: () => records, changed: ids => changed.push(ids) });
let nextId = 0;
async function result(cmd: string, value: unknown, isError = false) {
  const toolCallId = "call-" + nextId++;
  await emit("tool_call", { toolName: "bash", toolCallId, input: { command: cmd } });
  await emit("tool_result", { toolName: "bash", toolCallId, input: {}, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError });
}
await result(command("apply", "s_baseline", "--input", "/staged", "--database", db), receipt);
assert.deepEqual(changed.pop(), ["personal", "alias"], "All matching sources for this command and content DB become dirty; another command/database does not");
for (const cmd of [
  command("read", "s_baseline"), command("sync", "upstream", "status"), command("sync", "upstream", "plan"), command("sync", "local", "check"),
  "echo " + command("apply", "s_baseline"), command("apply", "s_baseline") + " && echo done",
  command("apply", "s_baseline") + "\necho done", command("apply", "$(selector)" ).replace("'$(selector)'", "$(selector)"),
  command("apply", "s_baseline", "--dry-run"), command("apply", "s_baseline", "--database", otherDb),
]) await result(cmd, receipt);
for (const value of [
  { ...receipt, ok: false }, { ...receipt, verified: false }, { ...receipt, dry_run: true },
  { ...receipt, action: "reuse", reused: true }, { ...receipt, action: "unchanged" }, { ...receipt, reused: true },
  { ...receipt, scope: "c".repeat(64) }, { ...receipt, record: { locator: { ...locator, database_id: otherDb } } },
  "truncated {\"ok\":true",
]) await result(command("apply", "s_baseline", "--database", db), value);
await result(command("apply", "s_baseline"), receipt, true);
assert.equal(changed.length, 0, "Reads, previews, unchanged/failed writes, mismatched scope and compound shell output cannot mark a source dirty");

// Hosts merge CLI stdout with the exact PublicationProgress JSONL written to stderr.
const publication = "p_44444444-4444-4444-8444-444444444444";
const progressedReceipt = { ...receipt, operation_id: publication };
const progress = (status = "completed", operation_id = publication) => ({ operation_id, stage: "verify", status, elapsed_ms: 15.25, stage_ms: 2.5 });
const jsonl = (...lines: unknown[]) => lines.map(line => typeof line === "string" ? line : JSON.stringify(line)).join("\n");
const sqliteWarning = "(node:7778) ExperimentalWarning: SQLite is an experimental feature and might change at any time";
const sqliteHint = "(Use `node --trace-warnings ...` to show where the warning was created)";
const progressCommand = command("apply", "s_baseline", "--progress", "--database", db);
for (const output of [
  jsonl(progress("started"), progress(), progressedReceipt),
  jsonl(sqliteWarning, sqliteHint, progress(), progressedReceipt),
  jsonl(progressedReceipt, progress(), sqliteWarning, sqliteHint),
]) {
  await result(progressCommand, output);
  assert.deepEqual(changed.pop(), ["personal", "alias"], "One complete same-operation receipt survives known stderr progress/warnings");
}
await result(command("apply", "s_baseline"), jsonl(sqliteWarning, sqliteHint, receipt));
assert.deepEqual(changed.pop(), ["personal", "alias"], "The precise Node SQLite warning does not require --progress");
assert.deepEqual(decodeCliWriteOutput(JSON.stringify(receipt, null, 2)), { status: "complete", result: receipt }, "Pure JSON keeps its original whitespace-tolerant fast path");
await result(command("apply", "s_baseline"), jsonl(progress(), progressedReceipt));
assert.equal(changed.length, 0, "JSONL progress requires the actual literal --progress argv");
for (const output of [
  jsonl(progress("completed", "p_another"), progressedReceipt),
  jsonl(progress(), progress("completed", "p_another"), progressedReceipt),
  jsonl(progress(), receipt),
  jsonl(progress(), progressedReceipt, progressedReceipt),
  jsonl({ ...progress(), extra: "unknown" }, progressedReceipt),
  jsonl({ ...progress(), elapsed_ms: -1 }, progressedReceipt),
  jsonl({ ...progress(), stage_ms: null }, progressedReceipt),
  jsonl(progress("unknown"), progressedReceipt),
  jsonl({ ...progress(), status: ["started"] }, progressedReceipt),
  jsonl({ ...progress(), stage: "" }, progressedReceipt),
  jsonl({ message: "other JSON" }, progressedReceipt),
  jsonl("Unrecognized stderr text", progressedReceipt),
  jsonl("(node:7778) ExperimentalWarning: Another experimental feature", progressedReceipt),
  jsonl(sqliteHint, progressedReceipt),
  jsonl(progress(), '{"ok":true,"operation":"replace",…'),
]) {
  assert.equal(decodeCliWriteOutput(output, { progress: true }).status, "invalid");
  await result(progressCommand, output);
}
for (const ending of [{ ...progressedReceipt, reused: true, action: "reuse" }, { ...progressedReceipt, verified: false }, { ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN" } }]) {
  await result(progressCommand, jsonl(progress(), ending));
}
assert.equal(changed.length, 0, "No unknown/mixed operation, extra final, noise, truncation or unsuccessful outcome becomes a change");

// A public resume result confirms recovery, without claiming another content mutation.
const resumeResult = { ok: true, domain: "publication", operation_id: publication, state: "completed", verified: true,
  resume_supported: true, next: { argv: ["ntn-skills", "operation", "resume", publication], reason: "Continue the retained publication under its original guards." },
  result: { operation: "replace", page_id: page, effects: [], creation_recovery: [], creation_discovery: [], upload_recovery: [] } };
const resumeCommand = command("operation", "resume", publication, "--progress");
for (const output of [resumeResult, resumeResult, jsonl(progress(), resumeResult)]) {
  await result(resumeCommand, output);
  assert.deepEqual(changed.pop(), ["personal", "second", "alias"], "Verified recovery rereads only sources using this CLI, including a repeated completed operation with no source scope");
}
await result(command("operation", "resume", "--progress", publication), resumeResult);
assert.deepEqual(changed.pop(), ["personal", "second", "alias"]);
for (const domain of ["sync_upstream", "subscription_add", "subscription_update", "subscription_remove", "upstream_fork", "upstream_track"]) {
  await result(resumeCommand, { ...resumeResult, domain, state: "verified" });
  assert.deepEqual(changed.pop(), ["personal", "second", "alias"], "Public upstream recovery uses its existing verified terminal state");
}
for (const cmd of [
  command("operation", "show", publication), command("operation", "reconcile", publication), command("operation", "list"),
  command("operation", "resume"), command("operation", "resume", publication, "another-id"),
  command("operation", "resume", publication, "--database", db), command("operation", "resume", publication, "--dry-run"),
  command("operation", "resume", publication) + " && echo done", "/other-cli operation resume " + publication,
]) await result(cmd, resumeResult);
for (const value of [
  { ...resumeResult, ok: false }, { ...resumeResult, verified: false }, { ...resumeResult, dry_run: true },
  { ...resumeResult, operation_id: "p_other" }, { ...resumeResult, state: "unknown" }, { ...resumeResult, state: "running" },
  { ...resumeResult, state: "failed" }, { ...resumeResult, state: "verified" },
  { ...resumeResult, domain: "sync_upstream" }, { ...resumeResult, domain: "sync_local" },
  { ...resumeResult, domain: "database_init" }, { ...resumeResult, domain: ["publication"] },
  { ...resumeResult, state: ["completed"] },
]) await result(resumeCommand, value);
await result(resumeCommand, resumeResult, true);
assert.equal(changed.length, 0, "Only the exact resumed operation and its allowed verified terminal state can request a conservative reread");

const { action: _action, reused: _reused, ...baseUpdate } = receipt;
const updateReceipt = { ...baseUpdate, operation: "update", effects: { properties: ["default-context"] } };
await result(command("update", page, "--default-context"), updateReceipt);
assert.deepEqual(changed.pop(), ["personal", "alias"], "Metadata update retains its existing verified property-PATCH result contract");
for (const value of [
  { ...updateReceipt, effects: { properties: [] } }, { ...updateReceipt, verified: false },
  { ...updateReceipt, dry_run: true }, { ...updateReceipt, action: "unchanged" }, { ...updateReceipt, reused: true },
]) await result(command("update", page, "--default-context"), value);
assert.equal(changed.length, 0);

// Actual OMP stdout truncation and its subsequent full-line artifact read retain the original CLI owner.
await emit("tool_call", { toolName: "bash", toolCallId: "long", input: { command: command("apply", "s_baseline", "--database", db) } });
await emit("tool_result", { toolName: "bash", toolCallId: "long", input: {}, content: [{ type: "text", text: '{"ok":true,"operation":"replace","record":{"description":"literal artifact://2 from authored content"},…\n\n[Some lines truncated to 768 bytes. Use artifact://1:raw:1-1 to read line 1 whole]' }], isError: false });
assert.equal(changed.length, 0, "Opaque/truncated output is not a verified write");
for (const [toolCallId, path] of [["wrong", "artifact://2:raw:1-1"], ["complete", "artifact://1:raw:1-1"], ["repeated", "artifact://1:raw:1-1"]]) {
  await emit("tool_call", { toolName: "read", toolCallId, input: { path } });
  await emit("tool_result", { toolName: "read", toolCallId, input: { path }, content: JSON.stringify(receipt), isError: false });
  if (toolCallId === "wrong") assert.equal(changed.length, 0, "An authored artifact-looking string does not grant the tool result an output owner");
}
assert.deepEqual(changed.splice(0), [["personal", "alias"]], "Only the linked complete receipt invalidates, exactly once");

for (const [id, original, completed, expected] of [
  ["progress-artifact", jsonl(progress(), '{"ok":true,"operation":"replace",…'), progressedReceipt, 1],
  ["wrong-operation-artifact", jsonl(progress("completed", "p_another"), '{"ok":true,"operation":"replace",…'), progressedReceipt, 0],
  ["unknown-output-artifact", jsonl({ unexpected: true }, '{"ok":true,"operation":"replace",…'), progressedReceipt, 0],
  ["extra-final-artifact", jsonl(progressedReceipt, '{"ok":true,"operation":"replace",…'), progressedReceipt, 0],
] as const) {
  const path = `artifact://${id}:raw:2-2`;
  await emit("tool_call", { toolName: "bash", toolCallId: id, input: { command: progressCommand } });
  await emit("tool_result", { toolName: "bash", toolCallId: id, input: {}, content: original + `\n\n[Some lines truncated to 768 bytes. Use ${path} to read line 2 whole]`, isError: false });
  assert.equal(changed.length, 0, "A truncated receipt never marks a source dirty");
  await emit("tool_call", { toolName: "read", toolCallId: id + "-read", input: { path } });
  await emit("tool_result", { toolName: "read", toolCallId: id + "-read", input: { path }, content: JSON.stringify(completed), isError: false });
  assert.equal(changed.length, expected, "Artifact completion retains the original call's known progress identity and rejects earlier noise");
  changed.length = 0;
}

const upstream = (created: number) => ({ ok: true, verified: true, results: [{ operation: { state: "verified", database_id: otherDb, target_database_id: db, scope: auth }, members: { created, updated: 0, restored: 0, unchanged: 3 } }] });
await result(command("sync", "upstream", "run"), upstream(0));
assert.equal(changed.length, 0);
await result(command("sync", "upstream", "run"), upstream(1));
assert.deepEqual(changed.pop(), ["personal", "alias"], "Upstream content target, not subscription database, is refreshed");
const local = (action: string) => ({ ok: true, mode: "run", outcome: "complete", verified: true, targets: [{ phase: "verified", verified: true, bindings: [{ action, stage: "complete", verified: true, page_id: page, database_id: db, scope: auth }] }] });
for (const action of ["pull", "unchanged", "advance_baseline"]) await result(command("sync", "local", "run", "binding"), local(action));
assert.equal(changed.length, 0, "Successful reads and baseline-only local sync do not imply a Notion mutation");
await result(command("sync", "local", "run", "binding"), local("push"));
assert.deepEqual(changed.pop(), ["personal", "alias"]);
await result(command("sync", "local", "connect", page, "--from", "local"), { ...local("push"), binding: { page_id: page } });
assert.deepEqual(changed.pop(), ["personal", "alias"], "Connect forwards the same verified run result; only a push changes Notion");

// Exercise the real directory owner and its on-disk cache, not just receipt classification.
const root = await mkdtemp(join(tmpdir(), "broker-write-invalidation-"));
const previous = { ...process.env };
const previousCwd = process.cwd();
try {
  process.chdir(root);
  const fixture = join(root, "source.mjs"), state = join(root, "state.json"), log = join(root, "calls.jsonl"), config = join(root, "broker.json");
  await writeFile(fixture, `import {readFile,appendFile} from 'node:fs/promises';
const [state,log,...args]=process.argv.slice(2); await appendFile(log,JSON.stringify(args)+'\\n');
const database=args[args.indexOf('--database')+1], alias=JSON.parse(await readFile(state,'utf8'))[database];
if(args[0]==='ctl')console.log(JSON.stringify({ok:true,identity:database.replaceAll('-','').padEnd(64,'0'),catalog_max_age_ms:3600000}));
else if(args[0]==='list')console.log(JSON.stringify({ok:true,scope:'${auth}',fetched_at:Date.now(),records:[{id:'notion_page:${page}',kind:'skill',name:alias,alias,description:'verified metadata',default_context:false,entrypoint:'SKILL.md',locator:{type:'notion_page',page_id:'${page}',database_id:database,data_source_id:'${ds}'},ref:'skill://${page}/SKILL.md'}],count:1,databases:[{database_id:database,title:'Fixture',alias:'fixture',data_source_ids:['${ds}']}],coverage:{method:'explicit_database',exhaustive:true,search_index_limited:false,queried_data_sources:['${ds}'],failed_sources:[]},freshness:{policy:args.includes('--refresh')?'refresh':'default',validated_at:new Date().toISOString(),age_ms:0,max_age_ms:3600000,stale:false}}));
else throw Error('Unexpected command');
`);
  const runtimePrefix = [process.execPath, fixture, state, log];
  await mkdir(join(root, "home"));
  await mkdir(join(root, "agent"));
  await writeFile(state, JSON.stringify({ [db]: "before-write", [otherDb]: "untouched" }));
  await writeFile(config, JSON.stringify({ skillRoots: [], sources: [
    { id: "personal", namespace: "notion", type: "notion", command: runtimePrefix, database: db, cacheDir: join(root, "cache") },
    { id: "second", namespace: "second", type: "notion", command: runtimePrefix, database: otherDb, cacheDir: join(root, "cache") },
  ] }));
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.CONTEXT_BROKER_CONFIG = config;
  delete process.env.CONTEXT_BROKER_ROOTS;
  const events = new Map<string, Listener[]>();
  let provider: AutocompleteProvider | undefined;
  const current: AutocompleteProvider = { getSuggestions: async () => null, applyCompletion: () => { throw Error("Unexpected native completion"); } };
  const runtimeContext: ExtensionContext = { cwd: root, mode: "rpc", hasUI: false, sessionManager: { getSessionId: () => "catalog-session", getEntries: () => [] }, ui: { addAutocompleteProvider(factory) { provider = factory(current); } } };
  const runtimeApi: ExtensionAPI = { pi: {}, on(name, handler) { events.set(name, [...(events.get(name) ?? []), handler as unknown as Listener]); }, registerCommand() {} };
  const dispatch = async (name: string, event: unknown) => { for (const listener of events.get(name) ?? []) await listener(event as never, runtimeContext); };
  await contextBroker(runtimeApi);
  await dispatch("session_start", { type: "session_start" });
  const selections = async () => (await provider!.getSuggestions(["$"], 0, 1, undefined, () => {}))?.items.map(item => item.value) ?? [];
  // Session View discovery is a separate asynchronous owner; this assertion concerns the ordinary $ directory.
  const fullCatalogCalls = async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[])
    .filter(args => args[0] === "list" && !args.includes("--default-view") && !args.includes("--view"));
  assert.ok((await selections()).includes("$before-write@notion"));
  const callsBefore = await fullCatalogCalls();
  await writeFile(state, JSON.stringify({ [db]: "after-write", [otherDb]: "untouched" }));
  await dispatch("tool_call", { toolName: "bash", toolCallId: "write", input: { command: [...runtimePrefix, "apply", "s_baseline", "--database", db].map(quote).join(" ") } });
  await dispatch("tool_result", { toolName: "bash", toolCallId: "write", input: {}, content: JSON.stringify(receipt), isError: false });
  const next = await selections();
  assert.ok(next.includes("$after-write@notion"), "The next ordinary selection sees the renamed Skill without manual refresh");
  assert.ok(!next.includes("$before-write@notion"));
  assert.ok(next.includes("$untouched@second"));
  const callsAfter = (await fullCatalogCalls()).slice(callsBefore.length);
  assert.equal(callsAfter.length, 1, "An unrelated source reuses its existing directory cache");
  assert.ok(callsAfter[0]!.includes(db));
  assert.ok(callsAfter[0]!.includes("--refresh"), "A verified write bypasses the affected source's stale disk directory");
  const beforeResume = await fullCatalogCalls();
  await writeFile(state, JSON.stringify({ [db]: "after-recovery", [otherDb]: "untouched" }));
  await dispatch("tool_call", { toolName: "bash", toolCallId: "resume", input: { command: [...runtimePrefix, "operation", "resume", publication].map(quote).join(" ") } });
  await dispatch("tool_result", { toolName: "bash", toolCallId: "resume", input: {}, content: JSON.stringify(resumeResult), isError: false });
  const recovered = await selections();
  assert.ok(recovered.includes("$after-recovery@notion"), "Verified original-operation recovery refreshes the next selection without manual intervention");
  assert.ok(!recovered.includes("$after-write@notion"));
  assert.ok(recovered.includes("$untouched@second"));
  const resumedCalls = (await fullCatalogCalls()).slice(beforeResume.length);
  assert.equal(resumedCalls.length, 2, "Recovery without source scope conservatively rereads this CLI's configured sources");
  assert.ok(resumedCalls.every(args => args.includes("--refresh")));
  await dispatch("session_shutdown", { type: "session_shutdown" });
} finally {
  process.chdir(previousCwd);
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}
console.log("CLI write invalidation checks passed");
