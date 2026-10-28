import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCliWriteInvalidation } from "../src/cli-write-invalidation";
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
  await dispatch("session_shutdown", { type: "session_shutdown" });
} finally {
  process.chdir(previousCwd);
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
}
console.log("CLI write invalidation checks passed");
