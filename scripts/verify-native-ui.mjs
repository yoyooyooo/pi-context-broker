import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFakeProvider, isolatedEnv } from "../packages/context-broker/scripts/context-broker-e2e-fixture.mjs";
import { createNotionFixture, database as fixtureDatabase, canary as notionCanary, unflaggedCanary } from "./notion-integration-fixture.mjs";
import { runCacheNativeUi } from './notion-cache-lifecycle.mjs';
if (process.argv.some(arg => ["help", "--help", "-h"].includes(arg))) {
  console.log("Usage: node scripts/verify-native-ui.mjs [--notion|--notion-loading|--catalog-cache|--catalog-cache-failure|--source-dependencies|--name-collision|--upstream-labels]\nStandard modes use an owned Tern/OMP instance and controlled provider/source. Live cache acceptance is driven by verify-notion-integration.mjs --mode live-fixture --cache-lifecycle true; its --cache-lifecycle-spec PATH is an internal owned-harness input. No real model proof. Doctor: node .agents/skills/verify-context-broker/scripts/control.mjs doctor notion-editor");
  process.exit(0);
}
const loadingMode = process.argv.includes("--notion-loading");
const dependencyMode = process.argv.includes("--source-dependencies");
const collisionMode = process.argv.includes("--name-collision");
const catalogCacheFailureMode = process.argv.includes("--catalog-cache-failure");
const catalogCacheMode = catalogCacheFailureMode || process.argv.includes("--catalog-cache");
const upstreamMode = process.argv.includes("--upstream-labels");
const cacheSpecAt = process.argv.indexOf('--cache-lifecycle-spec');
const cacheSpec = cacheSpecAt < 0 ? undefined : JSON.parse(await readFile(process.argv[cacheSpecAt + 1], 'utf8'));
if (cacheSpec) {
  cacheSpec.env = Object.fromEntries(Object.entries(cacheSpec.env).filter(([name]) => !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)/i.test(name)));
  await writeFile(process.argv[cacheSpecAt + 1], JSON.stringify(cacheSpec, null, 2) + '\n', { mode: 0o600 });
}
const notionMode = loadingMode || collisionMode || catalogCacheMode || upstreamMode || process.argv.includes("--notion");
const skillToken = notionMode ? "ui-alpha@notion" : "ui-alpha";
const skillPrefix = "ui-a";
const alphaCanary = notionMode ? notionCanary : "NATIVE_UI_ALPHA_BODY_CANARY";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = await mkdtemp("/tmp/broker-ui-");
const socket = join(base, "control.sock");
const daemonSocket = join(base, "daemon.sock");
const ternDir = join(base, "tern");
const env = { ...process.env, TERN_CONFIG_DIR: ternDir, TERN_DAEMON_SOCKET: daemonSocket, STENCIL_LOG_DIR: join(base, "logs") };
const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`;
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: base, env, encoding: "utf8", timeout: 30_000, ...options });
  if (result.status !== 0) throw new Error(`${file}: ${result.stdout || result.stderr || result.error}`);
  return result.stdout;
}
function ctl(...args) {
  const result = JSON.parse(run("tern", ["ctl", "--control", socket, ...args]));
  assert.notEqual(result.ok, false, JSON.stringify(result));
  return result;
}
function nodes(value) {
  if (!value || typeof value !== "object") return [];
  return [...(Array.isArray(value) ? [] : [value]), ...Object.values(value).flatMap(nodes)];
}
function texts(value) { return nodes(value).flatMap(node => typeof node.text === "string" ? [node.text] : []); }
const editor = () => ctl("tree", ".sf-editor").nodes[0];
const type = text => ctl("type", JSON.stringify(text));
const key = chord => ctl("key", chord);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(label, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(100); }
  throw new Error(`Native UI timed out: ${label}`);
}
const capturePath = join(base, "provider.jsonl");
async function captures() {
  try { return (await readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line).context); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function draft(text) { key("cmd+a"); key("backspace"); type(text); }
async function accept(prefix) {
  type(prefix);
  await until(`candidate ${prefix}`, () => texts(ctl("tree")).some(text => text.includes("[skill]") || text.includes("[router]")));
  key("tab");
  const selectedToken=prefix.includes("ui-ro")?"ui-router":skillToken;
  await until(`accepted ${selectedToken}`, () => editor()?.text?.includes(`$${selectedToken}`));
}
async function submit(expectedRequest, alpha, router) {
  key("enter");
  await until("provider request", async () => (await captures()).length === expectedRequest);
  const context = (await captures()).at(-1);
  const body = JSON.stringify(context.messages);
  assert.equal(body.split(alphaCanary).length - 1, alpha);
  assert.equal(body.split('<context-broker-record kind=\\"router\\" name=\\"ui-router\\"').length - 1, router);
  await until("idle composer", () => editor()?.text === "What are we cooking?");
}
const provider = await writeFakeProvider(base);
const toolPlanPath = join(base, "tool-plan.json");
if (loadingMode || cacheSpec) {
  await writeFile(toolPlanPath, JSON.stringify({ trigger: "NEVER", id: "cold-native-read", path: "skill://notion-ui-alpha" }));
  let source = await readFile(provider, "utf8");
  source = source.replace('import { appendFileSync }', 'import { appendFileSync, readFileSync }');
  source = source.replace('const output = {', `const plan = JSON.parse(readFileSync(${JSON.stringify(toolPlanPath)}, "utf8"));
  const lastUser = [...context.messages].reverse().find(message => message.role === "user");
  const requested = lastUser && JSON.stringify(lastUser).includes(plan.trigger);
  const completed = context.messages.some(message => message.role === "toolResult" && message.toolCallId === plan.id);
  const call = requested && !completed ? { type: "toolCall", id: plan.id, name: "read", arguments: { path: plan.path } } : null;
  const output = {`);
  source = source.replace('content: [{ type: "text", text: "OK" }]', 'content: call ? [call] : [{ type: "text", text: "OK" }]');
  source = source.replace('stopReason: "stop"', 'stopReason: call ? "toolUse" : "stop"');
  source = source.replace('for (const event of events) yield event;', `if (call) {
        yield { type: "start", partial: output };
        yield { type: "toolcall_start", contentIndex: 0, partial: output };
        yield { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output };
        yield { type: "done", reason: "toolUse", message: output };
      } else for (const event of events) yield event;`);
  await writeFile(provider, source);
}
const skillRoot = join(base, "skills");
const longSkillNames = ["notion-github-cicd-bootstrap", "notion-hai-audit-documentation", "notion-resource-tag-normalization"];
const longSkillLabels = () => ctl("tree", ".sf-overlay .sf-item-label").nodes.filter(label => longSkillNames.some(name => texts(label).some(text => text.includes(name))));
for (const name of longSkillNames) {
  await mkdir(join(skillRoot, name), { recursive: true });
  await writeFile(join(skillRoot, name, "SKILL.md"), `---\nname: ${name}\ndescription: Review the full workflow and its resources before applying this Skill.\n---\nLong completion layout fixture.\n`);
}
for (const [name, marker] of [["ui-alpha", "NATIVE_UI_ALPHA_BODY_CANARY"], ["ui-beta", "NATIVE_UI_BETA_BODY_CANARY"]]) {
  await mkdir(join(skillRoot, name), { recursive: true });
  await writeFile(join(skillRoot, name, "SKILL.md"), `---\nname: ${name}\ndescription: Native UI verification\n---\n${marker}\n`);
}
const config = join(base, "broker.yml");
const catalog = join(base, "catalog.yml");
await writeFile(catalog, "version: 1\nrecords:\n  - kind: router\n    name: ui-router\n    description: Native UI Router\n    members:\n      include: [ui-beta]\n");
await writeFile(config, `skillRoots:\n  - ${JSON.stringify(skillRoot)}\ndiscoveryCatalogs:\n  - ${JSON.stringify(catalog)}\n`);
let notionFixture;
if (notionMode) {
  notionFixture = await createNotionFixture(join(base, "notion-fixture"));
  await writeFile(config, JSON.stringify({ ...(collisionMode ? { skillRoots: [skillRoot], requireAutoload: false } : {}), sources: [{ type: "notion", id: "notion", namespace: "notion", database: fixtureDatabase, command: notionFixture.command, cacheDir: join(base, "notion-cache"), ...(loadingMode ? { requestTimeoutMs: 36_000 } : {}) }] }));
  if (upstreamMode) await notionFixture.setScenario("normal", { upstream: { repo: "fixture-repo" }, defaultContext: false, includeUnflagged: true });
  if (loadingMode) {
    const setScenario = notionFixture.setScenario;
    notionFixture.setScenario = (scenario, options = {}) => setScenario(scenario, { defaultContext: false, ...options });
    await notionFixture.setScenario("controlled-read", { delayMs: 65_000 });
  }
}
if (cacheSpec) await writeFile(config, JSON.stringify({ sources: [cacheSpec.source] }));
if (dependencyMode) {
  notionFixture = await createNotionFixture(join(base, "known-source-fixture"));
  await notionFixture.setScenario("normal", { defaultContext: false });
  await writeFile(config, JSON.stringify({ skillRoots: [skillRoot], sources: [
    { type: "notion", id: "notion", command: join(base, "absent-ntn-skills") },
    { type: "notion", id: "known", command: notionFixture.command, cacheDir: join(base, "known-cache") },
  ] }));
}
const manualSkillToken = notionMode
  ? `ui-alpha@${notionFixture.skillRef.split("/")[2].replaceAll("-", "")}@notion`
  : `ui-alpha@${encodeURIComponent("local:" + join(skillRoot, "ui-alpha", "SKILL.md"))}@local`;
const agentDir = join(base, "agent");
await mkdir(agentDir);
await writeFile(join(agentDir, "config.yml"), "startup:\n  setupWizard: false\n  checkUpdate: false\ncompaction:\n  enabled: false\n");
await mkdir(join(ternDir, "plugin-data/context-broker"), { recursive: true });
await writeFile(join(ternDir, "plugin-data/context-broker/config.json"), JSON.stringify({ config, agentDir }));
// Remember Not Now in this isolated config before Tern can offer to manage omp.
await mkdir(join(ternDir, "omp"), { recursive: true });
await writeFile(join(ternDir, "omp/state.json"), JSON.stringify({ managed: false, checked: 0, no_build: false, offered: true }) + "\n");
const release = join(base, "release");
await mkdir(release);
const archive = join(base, "tern-context-broker.tar.gz");
run("tar", ["-czf", archive, "-C", join(root, "packages/tern-context-broker"), "plugin.toml", "window.luau", "composer.luau", "query", "README.md", "LICENSE"]);
run("tar", ["-xzf", archive, "-C", release]);
const omp = process.env.BROKER_UI_OMP ?? "omp";
const launcher = join(base, "start.sh");
const launchArgs = [omp, "--no-extensions", "--no-skills", "--no-rules", "--no-title", "--no-tools", "--session-dir", join(base, "sessions"), "-e", provider, "-e", process.env.BROKER_UI_EXTENSION ?? join(root, "packages/context-broker/src/index.ts"), "--model", "context-broker-e2e/fake"];
if (loadingMode || cacheSpec) launchArgs.splice(launchArgs.indexOf('--no-tools'), 1, '--tools', 'read');
const hostLaunchEnv = isolatedEnv({ base: join(base, "host-home"), agentDir, CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: capturePath, BROKER_E2E_PROCESS_LEDGER: join(base, "host-processes.jsonl") });
await mkdir(hostLaunchEnv.HOME, { recursive: true });
if (cacheSpec) Object.assign(hostLaunchEnv, cacheSpec.env, { OMP_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, CONTEXT_BROKER_CONFIG: config, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: capturePath });
if (catalogCacheMode) {
  await notionFixture.setScenario("normal", { cacheIdentity: true, defaultContext: false, includeUnflagged: true, catalogAgeMs: 120_000 });
  const seed = JSON.parse(run(process.execPath, [join(root, "packages/context-broker/dist/completion.mjs")], {
    env: hostLaunchEnv,
    input: JSON.stringify({ version: 1, text: "$ui-", cursor: 4, cwd: base, config }),
  }));
  assert.ok(seed.items.some(item => /^\$ui-beta@[0-9a-f]{32}@notion$/.test(item.value)));
  await notionFixture.setScenario("normal", { cacheIdentity: true, defaultContext: false, includeUnflagged: true, name: "ZZZ Alpha", listDelayMs: 6_000, ...(catalogCacheFailureMode ? { failList: true } : {}) });
}
const hostLauncher = join(base, "start.mjs");
const hostExit = join(base, "omp-exit.json");
const hostPid = join(base, "omp-pid.json");
const cacheAuthEnvironment = cacheSpec ? ", ...Object.fromEntries(['NOTION_API_TOKEN','NTN_API_TOKEN'].filter(key => process.env[key]).map(key => [key, process.env[key]]))" : '';
await writeFile(hostLauncher, `import {spawnHost,signalHost} from ${JSON.stringify(new URL("../packages/context-broker/scripts/context-broker-e2e-fixture.mjs", import.meta.url).href)};\nimport {writeFileSync} from 'node:fs';\nconst child=await spawnHost(${JSON.stringify(omp)},[...${JSON.stringify(launchArgs.slice(1))},...process.argv.slice(2)],{cwd:${JSON.stringify(base)},env:{...${JSON.stringify(hostLaunchEnv)}${cacheAuthEnvironment}},stdio:'inherit'});\nwriteFileSync(${JSON.stringify(hostPid)},JSON.stringify({pid:child.pid,launcherPid:process.pid}));\nprocess.on('SIGTERM',()=>signalHost(child,'SIGTERM'));\nprocess.on('SIGINT',()=>signalHost(child,'SIGINT'));\nchild.on('close',(code,signal)=>{writeFileSync(${JSON.stringify(hostExit)},JSON.stringify({pid:child.pid,code,signal,observedExit:true}));process.exit(code??1);});\n`, { mode: 0o700 });
await writeFile(launcher, `#!/bin/sh\nexec ${[process.execPath, hostLauncher].map(shellQuote).join(" ")}\n`, { mode: 0o755 });
let tern;
let daemon;
const ownedProcesses = [];
const processFile = join(base, "owned-processes.json");
async function own(child, role) {
  ownedProcesses.push({ role, pid: child.pid, command: child.spawnargs });
  child.once("close", (exitCode, signal) => { const record = ownedProcesses.find(row => row.pid === child.pid); if (record) Object.assign(record, { exitCode, signal, observedExit: true }); });
  await writeFile(processFile, JSON.stringify(ownedProcesses, null, 2) + "\n");
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await new Promise(resolve => child.once("close", resolve));
  clearTimeout(escalation);
}
try {
  daemon = spawn("tern", ["daemon", "--socket", daemonSocket], { cwd: base, env, stdio: ["ignore", "ignore", "pipe"] });
  let daemonFailure;
  let daemonLogs = Promise.resolve();
  daemon.on("error", error => { daemonFailure = error; });
  daemon.stderr.on("data", data => { daemonLogs = daemonLogs.then(() => appendFile(join(base, "daemon-start.log"), data)); });
  await own(daemon, "daemon");
  await until("owned daemon socket", async () => {
    if (daemonFailure) throw daemonFailure;
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("Owned Tern daemon exited before readiness");
    try { return (await stat(daemonSocket)).isSocket(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  await daemonLogs;
  tern = spawn("tern", ["--control", socket, "--out", join(base, "shots")], { cwd: base, env, stdio: ["ignore", "pipe", "pipe"] });
  await own(tern, "window");
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Tern control did not become ready")), 30_000);
    let logs = "";
    tern.stderr.on("data", data => { logs += data; if (logs.includes(`control on ${socket}`)) { clearTimeout(deadline); resolve(); } });
    tern.on("error", reject);
    tern.on("exit", code => { clearTimeout(deadline); reject(new Error(`Tern exited early: ${code}`)); });
  });
  run("tern", ["plugin", "install", release, "--json"]);
  const installed = JSON.parse(run("tern", ["plugin", "list", "--json"]));
  assert.ok(installed.plugins.some(plugin => plugin.id === "context-broker" && plugin.status === "ready"));
  assert.deepEqual(installed.problems, []);
  ctl("ready");
  ctl("run", shellQuote(launcher));
  await until("idle OMP composer", () => editor()?.text === "What are we cooking?");
  const rect = editor().rect;
  ctl("click", String(rect[0] + 100), String(rect[1] + 10));
  if (cacheSpec) {
    await runCacheNativeUi({ spec: cacheSpec, base, ctl, editor, draft, key, type, texts, captures, toolPlanPath, launcher });
  } else if (catalogCacheMode) {
    const sourceCalls = async () => (await readFile(notionFixture.callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    const selectedText = () => texts(ctl("tree", ".sf-overlay .sf-item.sel")).join(" ");
    await draft(catalogCacheFailureMode ? "$" : "$ui-");
    await until("cached candidates before refresh completion", () => texts(ctl("tree", ".sf-overlay .sf-item-label")).some(text => text.includes("$ui-beta@notion")));
    assert.equal((await sourceCalls()).filter(call => call.command === "catalog-ready").length, 1, "The cached popup appears while the new list is still pending");
    await until("visible catalog updating notice", () => texts(ctl("tree")).some(text => text.includes("Updating Notion catalog")));
    key("down");
    await until("select cached beta", () => selectedText().includes("$ui-beta@notion"));
    const before = { selection: selectedText(), tree: ctl("tree"), sourceCalls: await sourceCalls() };
    ctl("shot", "catalog-cached-choice");
    await until("background catalog settles", async () => catalogCacheFailureMode
      ? (await sourceCalls()).some(call => call.command === "catalog-failed")
      : (await sourceCalls()).filter(call => call.command === "catalog-ready").length === 2);
    await pause(250);
    assert.ok(selectedText().includes("$ui-beta@notion"), "Refreshing metadata cannot move the current choice to another record");
    ctl("shot", "catalog-refreshed-choice");
    key("tab");
    await until("cached choice accepted", () => editor()?.text?.includes("$ui-beta@notion"));
    assert.equal((await captures()).length, 0, "Completion never dispatches a provider request");
    type(" Apply the selected skill."); key("enter");
    await until("selected beta reaches provider", async () => (await captures()).length === 1 && editor()?.text === "What are we cooking?");
    assert.equal(JSON.stringify((await captures())[0].messages).split(unflaggedCanary).length - 1, 1);
    await draft("$ui-");
    await until("next request preserves usable catalog", () => catalogCacheFailureMode
      ? texts(ctl("tree", ".sf-overlay .sf-item-label")).some(text => text.includes("$ui-beta@notion")) && texts(ctl("tree")).some(text => text.includes("NOTION_REQUEST_FAILED"))
      : selectedText().includes("$ui-beta@notion"));
    ctl("shot", "catalog-next-query");
    const after = { selection: selectedText(), tree: ctl("tree"), sourceCalls: await sourceCalls() };
    await writeFile(join(base, "catalog-cache-result.json"), JSON.stringify({ ok: true, cachedBeforeRemote: true, selectedIdentityPreserved: true, selectionProviderDelta: 0, selectedBodyCount: 1, nextQueryUsesRefresh: !catalogCacheFailureMode, refreshFailurePreservesCached: catalogCacheFailureMode, before, after }, null, 2));
    key("escape"); await draft("");
  } else if (upstreamMode) {
    await draft("$fixture-repo/");
    await until("subscription members", () => ["UI Alpha", "UI Beta", "UI Gamma"].every(name => texts(ctl("tree", ".sf-overlay .sf-item-label")).includes(`fixture-repo/${name} [skill]`)));
    ctl("shot", "upstream-namespace-members");
    await draft("$fixture-repo/ui-a");
    await until("subscription member prefix", () => texts(ctl("tree", ".sf-overlay .sf-item-label")).includes("fixture-repo/UI Alpha [skill]"));
    ctl("shot", "upstream-namespace-filtered");
    await draft("$ui-a");
    await until("upstream repository label", () => texts(ctl("tree", ".sf-overlay .sf-item-label")).includes("fixture-repo/UI Alpha [skill]"));
    const candidate = ctl("tree");
    ctl("shot", "upstream-candidate");
    assert.equal((await captures()).length, 0);
    key("tab");
    await until("exact upstream selection token", () => editor()?.text?.replace(/^\p{Co}\s*/u, "").trim() === "$ui-alpha@notion");
    ctl("shot", "upstream-selected");
    assert.equal((await captures()).length, 0, "Accepting a display label only edits the draft");
    type(" Apply the selected upstream Skill.");
    await submit(1, 1, 0);
    ctl("shot", "upstream-submitted");
    const calls = (await readFile(notionFixture.callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(call => call.command === "read" && call.args[0] === notionFixture.skillRef));
    assert.ok(calls.some(call => call.command === "export" && call.phase === "completed"));
    await draft("前文😀$ui-a tail");
    for (let i = 0; i < 5; i++) key("left");
    key("escape"); key("ctrl+alt+shift+k");
    await until("upstream manual picker label", () => texts(ctl("tree")).includes("fixture-repo/UI Alpha [skill]"));
    ctl("shot", "upstream-manual-picker");
    key("enter");
    await until("upstream manual exact replacement", () => editor()?.text === `前文😀$${manualSkillToken} tail`);
    assert.equal((await captures()).length, 1, "Manual selection must preserve draft and provider count");
    ctl("shot", "upstream-manual-selected");
    await writeFile(join(base, "upstream-result.json"), JSON.stringify({ ok: true, namespaceMembers: ["UI Alpha", "UI Beta", "UI Gamma"], namespacePrefix: "$fixture-repo/", filteredPrefix: "$fixture-repo/ui-a", label: "fixture-repo/UI Alpha [skill]", token: "$ui-alpha@notion", selectedRef: notionFixture.skillRef, selectionProviderDelta: 0, submittedBodyCount: 1, manualDraft: editor().text, candidate, commands: calls, fixture: true }, null, 2));
  } else if (dependencyMode) {
    await until("unavailable source notice", () => texts(ctl("tree")).some(text => text.includes("SOURCE_COMMAND_UNAVAILABLE")));
    ctl("shot", "dependency-startup-warning");
    await draft("Reply OK."); key("enter");
    await until("ordinary chat survives missing dependency", async () => (await captures()).length === 1 && editor()?.text === "What are we cooking?");
    await draft("$ui-a");
    await until("local autocomplete survives missing dependency", () => ctl("tree", ".sf-overlay .sf-item").nodes.some(node => texts(node).some(text => text.includes("ui-alpha"))));
    ctl("shot", "dependency-local-completion");
    key("esc");
    const unknownDraft = "$example@notion Preserve this unknown reference.";
    await draft(unknownDraft); key("enter");
    await until("unknown reference survives missing dependency", async () => (await captures()).length === 2 && editor()?.text === "What are we cooking?");
    assert.ok(JSON.stringify((await captures()).at(-1)).includes(unknownDraft), "Unknown references in a failed namespace remain exact user text");
    ctl("shot", "dependency-unknown-reference");
    const sourceCalls = async () => (await readFile(notionFixture.callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal((await sourceCalls()).some(call => ["read", "export"].includes(call.command)), false, "Unknown references cannot fall back to a healthy source");
    await draft("$ui-alpha@k");
    await until("known source candidate", () => ctl("tree", ".sf-overlay .sf-item").nodes.some(node => texts(node).some(text => text.includes("$ui-alpha@known"))));
    key("tab");
    await until("known source accepted", () => editor()?.text?.replace(/\uf0eb\s*/g, "") === "$ui-alpha@known" && ctl("tree", ".sf-editor .sf-t-strong").nodes.some(node => texts(node).some(text => text.includes("ui-alpha@known"))));
    await notionFixture.setScenario("normal", { defaultContext: false, failRead: true });
    key("enter");
    await until("known selection read failure rejected", () => texts(ctl("tree")).some(text => text.includes("ACCESS_DENIED")));
    assert.equal((await captures()).length, 2, "Failure to read an accepted known selection must block provider dispatch");
    assert.ok((await sourceCalls()).some(call => call.command === "read" && call.args[0] === notionFixture.skillRef));
    assert.equal((await sourceCalls()).some(call => call.command === "export"), false);
    ctl("shot", "dependency-selection-blocked");
    await draft("$ui-a");
    key("esc");
    key("ctrl+alt+shift+k");
    await until("manual picker survives missing dependency", () => ctl("tree", "input").nodes.some(node => node.placeholder === "Search Context Broker content (insert token only)"));
    ctl("shot", "dependency-manual-picker");
    key("esc");
    await writeFile(join(base, "dependency-result.json"), JSON.stringify({ startupWarning: true, ordinaryChat: true, localAutocomplete: true, unknownReferencePreserved: true, knownSelectionAccepted: true, blockedDispatch: true, manualPicker: true, fixture: true }, null, 2));
  } else if (loadingMode) {
    const behaviorNames = ["coldDollarAndDraftOrdering", "warmDollar", "coldSlash", "timeoutAndRecovery", "escapeCancellation", "nativeStopCancellation", "coldNativeToolRead", "reloadResume", "displayDetailsExcludedFromProvider"];
    const result = { status: "running", fixture: true, behaviors: Object.fromEntries(behaviorNames.map(name => [name, { status: "pending" }])), boundaries: {} };
    const saveResult = async () => writeFile(join(base, "loading-result.json"), JSON.stringify(result, null, 2));
    const record = async (name, details) => { result.behaviors[name] = { status: "passed", ...details }; await saveResult(); };
    const step = async (name, action) => {
      result.activeBehavior = name; result.behaviors[name] = { status: "running" }; await saveResult();
      try { await action(); }
      catch (error) { result.status = "failed"; result.behaviors[name] = { status: "failed", error: error.message }; await saveResult(); throw error; }
    };
    // Whole-tree walk restricted to Read cards whose sf-tool ancestor lives inside an sf-main region,
    // so unrelated sf-tool panes (sf-dock etc.) cannot be misread as transcript Read records.
    const sfMainLoadingCards = () => {
      const root = ctl("tree");
      const out = [];
      const visit = (node, insideMain) => {
        if (!node) return;
        const cls = (node.class || "").split(" ");
        const nowInside = insideMain || cls.includes("sf-main");
        const labels = texts(node);
        const sourceError = cls.includes("st-error") && labels.some(text => /^context-broker (?:source \S+ unavailable|activation failed) \([A-Z_]+\)/.test(text));
        if (cls.includes("sf-tool") && nowInside && labels.includes("Read") && (labels.some(text => text.includes("ntn-skills://")) || sourceError)) out.push(node);
        const kids = node.children;
        if (Array.isArray(kids)) kids.forEach(k => visit(k, nowInside));
        else if (kids && typeof kids === "object") Object.values(kids).forEach(k => visit(k, nowInside));
      };
      const tree = root?.tree;
      if (Array.isArray(tree)) tree.forEach(n => visit(n, false));
      return out;
    };
    const loadingCards = sfMainLoadingCards;
    const runningCard = () => loadingCards().find(node => node.class.includes("st-running"));
    const loadingVisible = () => Boolean(runningCard());
    const latestCard = () => loadingCards().at(-1);
    const historyMarker = "Loading regression conversation remains visible";
    const detailsLabels = new Set();
    const sessionPaths = async () => (await readdir(join(base, "sessions"), { recursive: true })).filter(file => file.endsWith(".jsonl")).map(file => join(base, "sessions", file));
    let currentSession;
    let resumeFixture;
    const readCalls = async command => (await readFile(notionFixture.callsPath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse).filter(call => call.command === command);
    const clickNode = node => { assert.ok(node?.rect, "Public UI control must expose bounds"); ctl("click", String(node.rect[0] + node.rect[2] / 2), String(node.rect[1] + node.rect[3] / 2)); };
    async function assertNoDispatch(count, label, duration = 700) {
      const deadline = Date.now() + duration;
      do { assert.equal((await captures()).length, count, label); await pause(100); } while (Date.now() < deadline);
    }
    async function waitIdle() { await until("native composer idle", () => !loadingVisible() && editor()?.text === "What are we cooking?"); }
    async function refreshCold(scenario = "normal", options = {}) {
      await notionFixture.setScenario("normal");
      const previousSessions = new Set(await sessionPaths());
      const before = (await captures()).length;
      await draft("/new"); key("enter");
      await until("fresh session clears loaded conversation", () => loadingCards().length === 0 && !texts(ctl("tree")).some(text => text.includes(historyMarker)) && editor()?.text === "What are we cooking?");
      await draft(historyMarker); key("enter");
      await until("fresh session baseline reply", async () => (await captures()).length === before + 1 && editor()?.text === "What are we cooking?");
      assert.equal(JSON.stringify((await captures()).at(-1).messages).includes(alphaCanary), false, "Cold cases must start without loaded Skill instructions");
      const createdSessions = (await sessionPaths()).filter(path => !previousSessions.has(path));
      assert.equal(createdSessions.length, 1, "A cold case must own one newly created session");
      currentSession = createdSessions[0];
      const lists = (await readCalls("list")).length;
      await draft("/context-broker refresh"); key("enter");
      await until("source metadata refreshed", async () => (await readCalls("list")).length > lists);
      await waitIdle();
      await notionFixture.setScenario(scenario, options);
    }
    async function waitForRead(label, previousCount) {
      await until(`${label}: transcript Read ntn-skills:// running`, () => loadingCards().length === previousCount + 1 && loadingVisible());
      const target = nodes(latestCard()).find(node => node.class?.split(" ").includes("sf-tool-target"));
      assert.equal(texts(target).join(""), "ntn-skills://ui-alpha", "Read target must show the selected alias without its namespace");
      assert.equal(texts(ctl("tree")).some(text => text === "Load Skill"), false, "Composer Load Skill widget must be absent");
      assert.ok(editor()?.rect?.[2], "Loading must keep the native editor mounted");
      assert.ok(texts(ctl("tree")).some(text => text.includes(historyMarker)), "Loading must preserve the conversation");
      assert.equal(ctl("tree", ".sf-overlay").nodes.length, 0, "Loading must not open a modal");
      ctl("shot", label);
      await writeFile(join(base, `${label}-state.json`), JSON.stringify({ editor: editor(), tree: ctl("tree") }, null, 2));
    }
    async function terminalRecord(status, previousCount, label) {
      await until(`${label}: persistent ${status} Read record`, () => loadingCards().length === previousCount + 1 && latestCard()?.class.includes(`st-${status}`) && !loadingVisible());
      await until(`${label}: visible Read header`, () => {
        const head = nodes(latestCard()).find(node => node.class?.split(" ").includes("sf-tool-head"));
        return head?.rect?.[1] >= 40 && head.rect[1] + head.rect[3] <= editor().rect[1];
      });
      const collapsed = new Set(texts(latestCard()));
      clickNode(nodes(latestCard()).find(node => node.class?.split(" ").includes("sf-tool-title")));
      await until(`${label}: source details expand`, () => texts(latestCard()).some(text => !collapsed.has(text)));
      const details = texts(latestCard()).filter(text => !collapsed.has(text));
      assert.match(details.join("\n"), /notion|source|snapshot|SOURCE_|cancel/i, "Expanded Read record must expose source or outcome details");
      if (status === "done") assert.match(details.join("\n"), /snapshot|s_a{64}/i, "Successful Read details must identify the loaded snapshot");
      for (const text of details) if (text.length > 20 && /fetching|ready|cancel|error|source:|snapshot:/i.test(text) && !text.includes(alphaCanary) && !text.includes("ntn-skills://")) detailsLabels.add(text);
      ctl("shot", `${label}-expanded`);
      clickNode(nodes(latestCard()).find(node => node.class?.split(" ").includes("sf-tool-head")));
      await pause(3_000);
      assert.equal(loadingCards().length, previousCount + 1, "Terminal Read record must persist beyond the old removal timer");
      assert.ok(latestCard().class.includes(`st-${status}`));
      return details;
    }
    async function assertOriginalRequest(context, original, pendingDraft, cache = join(base, "notion-cache")) {
      const lastUser = context.messages.filter(message => message.role === "user").at(-1);
      assert.ok(JSON.stringify(lastUser).includes(original), "First provider request must end with the original invocation");
      const messages = JSON.stringify(context.messages);
      assert.equal(messages.split(alphaCanary).length - 1, 1, "Complete skill body must enter the first request exactly once");
      const recordKey = createHash("sha256").update(`notion_page:${notionFixture.skillRef.split("/")[2]}`).digest("hex");
      const entries = (await readdir(cache, { recursive: true })).filter(file => file.includes(`/records/${recordKey}/snapshots/`) && file.endsWith("/SKILL.md"));
      assert.equal(entries.length, 1, "The selected fixture must have one pinned Skill export");
      const exportedBytes = await readFile(join(cache, entries[0]), "utf8");
      const snapshotId = entries[0].split("/snapshots/")[1].split("/")[0];
      const pinnedRead = JSON.parse(await readFile(join(notionFixture.statePath + ".snapshots", snapshotId + ".json"), "utf8"));
      assert.equal(exportedBytes, pinnedRead.content, "Snapshot export entry must exactly equal the complete pinned read body");
      const exported = exportedBytes.trimEnd();
      const body = exported.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
      assert.ok(messages.includes(JSON.stringify(body).slice(1, -1)), "The first request must include the complete pinned Skill body");
      if (original.startsWith("$")) assert.ok(messages.includes(JSON.stringify(exported).slice(1, -1)), "Dollar activation must preserve the complete source body including frontmatter");
      if (pendingDraft) assert.equal(messages.includes(pendingDraft), false, "Pending draft must not overtake the original invocation");
      return lastUser;
    }
    await saveResult();
    await draft(historyMarker); key("enter");
    await until("baseline conversation reply", async () => (await captures()).length === 1 && editor()?.text === "What are we cooking?");
    await step("coldDollarAndDraftOrdering", async () => {
      const before = (await captures()).length;
      const cardCount = loadingCards().length;
      const original = `$${skillToken} Apply this original slow skill invocation.`;
      const pendingDraft = "Pending ordinary draft must wait for explicit submission.";
      const started = Date.now();
      await draft(""); await accept(`$${skillPrefix}`); type("Apply this original slow skill invocation."); key("enter");
      await waitForRead("slow-cold-dollar-loading", cardCount);
      await assertNoDispatch(before, "Cold $ must load before any provider request");
      await draft(pendingDraft); key("enter");
      await assertNoDispatch(before, "Enter during preparation must not submit the pending draft");
      assert.equal(editor().text, pendingDraft, "Enter during preparation must preserve the editable draft");
      await until("65s cold $ original provider request", async () => { const count = (await captures()).length; assert.ok(count <= before + 1, "Pending draft must not auto-dispatch"); return count === before + 1; }, 80_000);
      assert.ok(Date.now() - started >= 65_000, "Cold $ must finish beyond the removed 60s command deadline");
      const lastUser = await assertOriginalRequest((await captures()).at(-1), original, pendingDraft);
      await terminalRecord("done", cardCount, "slow-cold-dollar-done");
      assert.equal(editor().text, pendingDraft, "Completing the original request must retain the draft");
      await assertNoDispatch(before + 1, "Preparation completion must not auto-submit the draft");
      key("enter");
      await until("explicit pending draft provider request", async () => (await captures()).length === before + 2);
      const nextUser = (await captures()).at(-1).messages.filter(message => message.role === "user").at(-1);
      assert.ok(JSON.stringify(nextUser).includes(pendingDraft), "Explicit draft submission must follow the original request");
      await waitIdle();
      await record("coldDollarAndDraftOrdering", { delayedReadMs: 65_000, requestTimeoutMs: 36_000, requestsBefore: before, requestsAfter: before + 2, lastUser, nextUser, draftRetained: true });
    });
    await step("warmDollar", async () => {
      const reads = (await readCalls("read")).length;
      const before = (await captures()).length;
      const cards = loadingCards().length;
      const original = `$${skillToken} Apply the warm skill.`;
      await draft(original); key("enter");
      await until("warm $ provider request", async () => (await captures()).length === before + 1);
      await assertOriginalRequest((await captures()).at(-1), original);
      await waitIdle();
      assert.equal((await readCalls("read")).length, reads, "Warm $ must not perform another source read");
      assert.equal(loadingCards().length, cards, "Warm $ must not create another loading record");
      await record("warmDollar", { extraReads: 0 });
    });
    await step("coldSlash", async () => {
      await refreshCold("controlled-read", { delayMs: 4_000 });
      const before = (await captures()).length;
      const cards = loadingCards().length;
      const original = "/skill:notion-ui-alpha Apply this cold slash skill.";
      await draft(original); key("enter");
      await waitForRead("cold-slash-loading", cards);
      await assertNoDispatch(before, "Cold /skill must not pre-dispatch");
      await until("cold /skill provider request", async () => (await captures()).length === before + 1);
      await assertOriginalRequest((await captures()).at(-1), "Apply this cold slash skill.");
      await terminalRecord("done", cards, "cold-slash-done");
      await waitIdle();
      await record("coldSlash", { bodyCopies: 1, preflightProviderRequests: 0 });
    });
    await step("timeoutAndRecovery", async () => {
      await refreshCold("timeout");
      const before = (await captures()).length;
      const cards = loadingCards().length;
      await draft(`$${skillToken} Time out before dispatch.`); key("enter");
      await waitForRead("timeout-loading", cards);
      await until("request timeout error", () => texts(ctl("tree")).some(text => text.includes("NTN_UNAVAILABLE")), 45_000);
      await terminalRecord("error", cards, "timeout-error");
      await assertNoDispatch(before, "Timeout must never dispatch a provider request");
      await notionFixture.setScenario("normal");
      const original = `$${skillToken} Recover after timeout.`;
      await draft(original); key("enter");
      await until("timeout recovery provider request", async () => (await captures()).length === before + 1);
      await assertOriginalRequest((await captures()).at(-1), original);
      await waitIdle();
      await terminalRecord("done", cards + 1, "timeout-recovered");
      resumeFixture = { session: currentSession, states: loadingCards().map(card => ["running", "done", "error"].find(state => card.class.includes(`st-${state}`))) };
      await record("timeoutAndRecovery", { requestTimeoutMs: 36_000, failedProviderRequests: 0, recovery: true });
    });
    for (const method of ["escape", "nativeStop"]) await step(`${method}Cancellation`, async () => {
      const delayMs = method === "nativeStop" ? 32_000 : 5_000;
      await refreshCold("controlled-read", { delayMs });
      const before = (await captures()).length;
      const cards = loadingCards().length;
      await draft(`$${skillToken} Cancel via ${method}.`); key("enter");
      await waitForRead(`${method}-loading`, cards);
      const pendingDraft = `Editable draft after ${method} cancellation.`;
      await draft(pendingDraft);
      if (method === "escape") key("esc");
      else {
        // Walk the full tree because selector queries omit child nodes.
        const stop = nodes(ctl("tree")).find(n => n?.text === "Stop" && (n.class || "").split(" ").includes("sf-act"));
        assert.ok(stop?.rect && texts(stop).includes("Stop"), "Preparation must expose the native Stop button as an sf-act text node with rect bounds");
        clickNode(stop);
      }
      await terminalRecord("error", cards, `${method}-cancelled`);
      assert.equal(editor().text, pendingDraft, "Cancelling preparation must retain the edited draft");
      await assertNoDispatch(before, "Cancellation must reject late source completion", delayMs + 500);
      await notionFixture.setScenario("normal");
      key("enter");
      await until("ordinary draft submits after cancellation", async () => (await captures()).length === before + 1);
      assert.ok(JSON.stringify((await captures()).at(-1).messages.filter(message => message.role === "user").at(-1)).includes(pendingDraft));
      await waitIdle();
      await record(`${method}Cancellation`, { cancelledProviderRequests: 0, draftRetained: true, ordinaryRecovery: true, lateCompletionBlocked: true });
    });
    await step("coldNativeToolRead", async () => {
      // This case needs a cold source process as well as an unloaded conversation.
      // Earlier cases retain a valid pinned native path in the running host.
      const coldConfig = JSON.parse(await readFile(config, "utf8"));
      coldConfig.sources[0].cacheDir = join(base, "native-notion-cache");
      await writeFile(config, JSON.stringify(coldConfig));
      await draft("/quit"); key("enter");
      await until("previous owned OMP exits", () => !editor());
      ctl("run", shellQuote(launcher));
      await until("cold native-read OMP composer", () => editor()?.text === "What are we cooking?", 30_000);
      await refreshCold("controlled-read", { delayMs: 4_000 });
      const before = (await captures()).length;
      const cards = loadingCards().length;
      const reads = (await readCalls("read")).length;
      await writeFile(toolPlanPath, JSON.stringify({ trigger: "Exercise cold native tool reading", id: "cold-native-read", path: notionFixture.skillRef }));
      await draft("Exercise cold native tool reading"); key("enter");
      await until("genuine model read preparation", async () => (await captures()).length === before + 1 && (await readCalls("read")).length === reads + 1 && texts(ctl("tree")).includes("Stop"));
      assert.equal((await captures()).length, before + 1, "Genuine read must originate in the model's first request before its tool result request");
      assert.equal(texts(ctl("tree")).some(text => text === "Load Skill"), false, "Genuine model read must not duplicate a composer loading widget");
      ctl("shot", "native-tool-read-preparing");
      await until("genuine model read result", async () => (await captures()).length === before + 2);
      const toolResult = (await captures()).at(-1).messages.find(message => message.role === "toolResult" && message.toolCallId === "cold-native-read");
      assert.ok(toolResult && !toolResult.isError && JSON.stringify(toolResult).includes(alphaCanary), "Native read must return the actual skill body");
      const toolCall = (await captures()).at(-1).messages.find(message => message.role === "assistant" && message.content?.some(part => part.type === "toolCall" && part.id === "cold-native-read"))?.content.find(part => part.type === "toolCall" && part.id === "cold-native-read");
      assert.ok(toolCall?.arguments?.path?.includes("/snapshots/s_") && toolCall.arguments.path.endsWith("/SKILL.md"), "Native read must use the selected pinned snapshot");
      assert.equal(loadingCards().length, cards, "Genuine native read must not add a synthetic activation record");
      assert.ok(nodes(ctl("tree")).some(node => node.class?.split(" ").includes("sf-tool") && node.class.includes("st-done") && texts(node).includes("Read") && texts(node).some(text => text.includes("notion-cache"))), "Native transcript must retain the genuine completed Read row");
      ctl("shot", "native-tool-read-done");
      await waitIdle();
      await record("coldNativeToolRead", { genuineRead: true, providerRequests: 2, noLoadSkillWidget: true });
    });
    await step("reloadResume", async () => {
      const before = (await captures()).length;
      assert.ok(resumeFixture?.session, "Timeout recovery must retain its exact owned session for resume");
      const { session, states: expectedStates } = resumeFixture;
      assert.ok(expectedStates.includes("done") && expectedStates.includes("error"), "Resume fixture must contain successful and failed Read records");
      assert.equal(expectedStates.includes("running"), false, "No Read record may remain running before reopen");
      assert.ok((await sessionPaths()).includes(session), "Resume must select the recorded owned session JSONL");
      const resumeLauncher = join(base, "resume.sh");
      const command = (await readFile(launcher, "utf8")).trimEnd();
      await writeFile(resumeLauncher, `${command} --resume ${shellQuote(session)}\n`, { mode: 0o755 });
      await draft("/quit"); key("enter");
      await until("owned OMP quits without closing Tern pane", () => !editor());
      ctl("run", shellQuote(resumeLauncher));
      await until("resumed OMP native composer", () => editor()?.text === "What are we cooking?", 30_000);
      await until("persisted transcript Read records restored", () => loadingCards().length === expectedStates.length);
      const restoredStates = loadingCards().map(card => ["running", "done", "error"].find(state => card.class.includes(`st-${state}`)));
      assert.deepEqual(restoredStates, expectedStates, "Read terminal records must survive host reopen with their status");
      assert.equal(loadingVisible(), false, "Resumed loading records must never restore running state");
      await assertNoDispatch(before, "Reopening a session must not dispatch provider work");
      const head = nodes(latestCard()).find(node => node.class?.split(" ").includes("sf-tool-head"));
      const collapsed = new Set(texts(latestCard()));
      clickNode(head);
      await until("resumed Read details remain expandable", () => texts(latestCard()).some(text => !collapsed.has(text)));
      assert.match(texts(latestCard()).filter(text => !collapsed.has(text)).join("\n"), /notion|source|snapshot|SOURCE_|cancel/i);
      ctl("shot", "resumed-read-records");
      clickNode(nodes(latestCard()).find(node => node.class?.split(" ").includes("sf-tool-head")));
      const resumedDraft = "Ordinary turn after resuming persisted Read records.";
      await draft(resumedDraft); key("enter");
      await until("resumed ordinary provider request", async () => (await captures()).length === before + 1);
      assert.ok(JSON.stringify((await captures()).at(-1).messages.filter(message => message.role === "user").at(-1)).includes(resumedDraft));
      await waitIdle();
      await record("reloadResume", { trigger: "/quit then owned launcher --resume exact session JSONL", records: restoredStates.length, states: restoredStates, reopenProviderRequests: 0, ordinaryContinuation: true });
    });
    await step("defaultContextNativeStop", async () => {
      await draft("/quit"); key("enter");
      await until("owned OMP quits before cold shared-cache scenario", () => !editor());
      const sharedCache = join(base, "shared-prefetch-cache");
      const sharedConfig = JSON.parse(await readFile(config, "utf8"));
      sharedConfig.sources[0].cacheDir = sharedCache;
      await writeFile(config, JSON.stringify(sharedConfig));
      await notionFixture.setScenario("controlled-read", { delayMs: 32_000, defaultContext: true });
      const before = (await captures()).length;
      const reads = (await readCalls("read")).length;
      const exports = (await readCalls("export")).filter(call => call.phase === "completed").length;
      ctl("run", shellQuote(launcher));
      await until("cold shared-cache OMP composer", () => editor()?.text === "What are we cooking?", 30_000);
      await until("checked Skill background read starts", async () => (await readCalls("read")).length === reads + 1);
      await draft(historyMarker); key("enter");
      await until("shared-cache metadata-only baseline", async () => (await captures()).length === before + 1 && editor()?.text === "What are we cooking?");
      assert.equal(JSON.stringify((await captures()).at(-1)).includes(alphaCanary), false, "Checked background preparation must remain outside the first provider context");
      const providersBeforeCancel = (await captures()).length;
      const cards = loadingCards().length;
      assert.equal(cards, 0, "Background preparation must not publish a foreground Read record");
      await assertNoDispatch(providersBeforeCancel, "Background preparation must not dispatch provider work");
      await draft(`$${skillToken} Cancel this consumer while background preparation continues.`); key("enter");
      await waitForRead("default-context-shared-loading", cards);
      const stop = nodes(ctl("tree")).find(node => node.text === "Stop" && node.class?.split(" ").includes("sf-act"));
      assert.ok(stop?.rect, "Shared preparation must expose the native Stop action");
      clickNode(stop);
      await terminalRecord("error", cards, "default-context-consumer-cancelled");
      await until("background survives cancelled consumer", async () => (await readCalls("export")).filter(call => call.phase === "completed").length === exports + 1, 45_000);
      assert.equal((await readCalls("read")).length, reads + 1, "Cancelled foreground and surviving background must share one source read");
      await assertNoDispatch(providersBeforeCancel, "Cancelled foreground must not dispatch when shared preparation finishes");
      assert.equal(loadingCards().length, cards + 1, "Background completion must not add an activation record");
      assert.ok(latestCard().class.includes("st-error"), "Background completion must not reactivate the cancelled submission");
      ctl("shot", "default-context-background-survived-stop");
      await notionFixture.setScenario("normal", { defaultContext: true });
      const original = `$${skillToken} Apply the prepared instructions after cancellation.`;
      await draft(original); key("enter");
      await until("prepared retry provider request", async () => (await captures()).length === providersBeforeCancel + 1);
      await assertOriginalRequest((await captures()).at(-1), original, undefined, sharedCache);
      await waitIdle();
      const recordKey = createHash("sha256").update(`notion_page:${notionFixture.skillRef.split("/")[2]}`).digest("hex");
      const resources = (await readdir(sharedCache, { recursive: true })).filter(file => file.includes(`/records/${recordKey}/snapshots/`) && file.endsWith("/references/ledger.md"));
      assert.equal(resources.length, 1, "Surviving preparation must export the pinned resource");
      await writeFile(toolPlanPath, JSON.stringify({ trigger: "OPEN_SURVIVING_PREFETCH_RESOURCE", id: "surviving-prefetch-resource", path: join(sharedCache, resources[0]) }));
      await draft("OPEN_SURVIVING_PREFETCH_RESOURCE: read the prepared ledger guide."); key("enter");
      await until("surviving pinned resource consumed", async () => (await captures()).length === providersBeforeCancel + 3);
      const resourceResult = (await captures()).at(-1).messages.find(message => message.role === "toolResult" && message.toolCallId === "surviving-prefetch-resource");
      assert.ok(resourceResult && !resourceResult.isError && JSON.stringify(resourceResult).includes(notionFixture.resourceCanary), "Actual native read must consume the surviving pinned resource");
      assert.equal((await readCalls("export")).filter(call => call.phase === "completed").length, exports + 1, "Retry and resource read must reuse the complete prepared export");
      await waitIdle();
      ctl("shot", "default-context-retry-resource");
      await record("defaultContextNativeStop", { cancelledProviderRequests: 0, sharedReads: 1, sharedExports: 1, backgroundSurvived: true, retryBodyCopies: 1, resourceConsumed: true });
      await notionFixture.setScenario("normal");
    });
    await step("displayDetailsExcludedFromProvider", async () => {
      const displayLabels = /Fetching the selected Skill and its resources\.|Skill and resources ready\.|Load Skill/;
      for (const context of await captures()) {
        const body = JSON.stringify(context.messages);
        assert.doesNotMatch(body, displayLabels, "Display feedback must not enter provider messages");
        for (const detail of detailsLabels) assert.equal(body.includes(JSON.stringify(detail).slice(1, -1)), false, "Expanded loading details must remain display-only");
      }
      await record("displayDetailsExcludedFromProvider", { capturesChecked: (await captures()).length, expandedDetailsChecked: detailsLabels.size });
    });
    result.boundaries.imageAttachment = "No existing native UI image attachment helper; this harness does not claim image preservation coverage.";
    result.boundaries.sessionSwitchDuringPrepare = "Public /new is gated during preparation; main agent must exercise actual lifecycle switch through existing RPC harness.";
    result.status = "passed"; delete result.activeBehavior; await saveResult();
  } else if (collisionMode) {
    await draft("$ui-a");
    await until("local collision candidate", () => texts(ctl("tree", ".sf-overlay .sf-item-label")).some(text => text.includes("$ui-alpha@local")));
    const localToken = "$ui-alpha@local";
    ctl("shot", "collision-candidates");
    key("tab");
    await until("selected local collision chip", () => editor()?.text?.includes(localToken));
    type(" Apply these instructions.");
    ctl("shot", "collision-local-chip");
    await submit(1, 0, 0);
    assert.ok(JSON.stringify((await captures())[0].messages).includes("NATIVE_UI_ALPHA_BODY_CANARY"), "Local selection must deliver the local body");
    const localCalls = (await readFile(notionFixture.callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(localCalls.some(call => ["read", "export"].includes(call.command)), false, "Local selection must not activate the same-name source");
    await accept("$ui-alpha@not");
    type(" Apply the remote instructions.");
    await submit(2, 1, 0);
    const selectedBodies = JSON.stringify((await captures())[1].messages);
    assert.equal(selectedBodies.split("NATIVE_UI_ALPHA_BODY_CANARY").length - 1, 1);
    await draft("$ui-alpha Reject the ambiguous reference.");
    key("escape"); key("enter");
    await until("actionable ambiguity notification", () => texts(ctl("tree")).some(text => text.includes("ambiguous") && text.includes(localToken) && text.includes("$ui-alpha@notion")));
    assert.equal((await captures()).length, 2, "Bare same-name selection must block provider dispatch");
    ctl("shot", "collision-ambiguity");
    await writeFile(join(base, "collision-result.json"), JSON.stringify({ localToken, localBody: true, sourceBody: true, localSelectionSourceReads: 0, ambiguousProviderRequests: 0, actionableError: true }, null, 2));
  } else {
  if (!notionMode) {
    await draft("$notion-");
    await until("long Skill completion menu", () => longSkillLabels().length === longSkillNames.length);
    await pause(250);
    const card = ctl("tree", ".sf-overlay .sf-ov-card").nodes[0];
    assert.ok(card?.rect?.[2] >= 700, "Dollar completion must use the wider native overlay");
    const labels = longSkillLabels();
    assert.ok(labels.every(label => label.rect[2] >= 280), "Long candidate names must receive enough width to remain readable");
    ctl("shot", "wide-dollar-menu");
    const layouts = { wide: { card, labels, details: ctl("tree", ".sf-overlay .sf-item-detail").nodes } };
    async function boundedMenu(name) {
      await until(name, () => longSkillLabels().length === longSkillNames.length);
      await pause(250);
      const card = ctl("tree", ".sf-overlay .sf-ov-card").nodes[0];
      const layer = ctl("tree", ".sf-overlay").nodes[0];
      assert.ok(card.rect[0] >= layer.rect[0] && card.rect[0] + card.rect[2] <= layer.rect[0] + layer.rect[2] + 1, "Completion menu must stay within the pane at the viewport edge");
      assert.ok(card.rect[2] <= layer.rect[2] - 15, "Completion menu must retain an inset on narrow panes");
      layouts[name] = { card, layer, labels: ctl("tree", ".sf-overlay .sf-item-label").nodes };
      ctl("shot", name);
    }
    key("escape"); await draft(`${"正文".repeat(22)}$notion-`);
    await boundedMenu("wide-dollar-right-edge");
    key("escape"); await draft("");
    ctl("resize", "620", "800");
    await pause(250); type("$notion-");
    await boundedMenu("wide-dollar-narrow");
    key("escape"); await draft("");
    ctl("resize", "1280", "800");
    await pause(250); type("/");
    await until("native slash menu", () => ctl("tree", ".sf-overlay .sf-item").nodes.length > 0);
    await pause(250);
    const native = ctl("tree", ".sf-overlay .sf-ov-card").nodes[0];
    assert.ok(native.rect[2] < 500, "Native slash completion must retain its host width");
    layouts.nativeSlash = { card: native };
    await writeFile(join(base, "wide-dollar-menu.json"), JSON.stringify(layouts, null, 2));
    key("escape"); await draft("");
  }
  await accept(`中文😀正文$${skillPrefix}`);
  assert.ok(editor().text.includes(`$${skillToken}`));
  const acceptedDraft = editor().text;
  const chip = ctl("tree", ".sf-editor .sf-t-strong").nodes.find(node => node.text?.includes(`$${skillToken}`));
  assert.ok(chip?.rect, "Accepted dollar chip must expose its actual text bounds");
  for (const fraction of [0.35, 0.65, 0.9]) {
    ctl("click", String(chip.rect[0] + chip.rect[2] * fraction), String(chip.rect[1] + chip.rect[3] / 2));
    await pause(350);
    const caret = ctl("tree", ".sf-editor .sf-caret").nodes[0];
    assert.ok(caret?.rect && caret.rect[0] > chip.rect[0] && caret.rect[0] < chip.rect[0] + chip.rect[2], "Mouse must place the caret inside the accepted chip text");
    assert.equal(editor().text, acceptedDraft, "Caret placement must preserve the accepted draft");
    assert.equal(ctl("tree", ".sf-overlay .sf-item").nodes.length, 0, "Clicking inside an accepted chip must not reopen autocomplete");
  }
  ctl("shot", "chip-caret-no-dropdown");
  key("cmd+right");
  key("left"); key("backspace");
  await until("atomic chip deletion", () => editor()?.text === "中文😀正文");
  key("ctrl+z");
  await until("chip undo restored", () => editor()?.text?.includes(`$${skillToken}`));
  if (!notionMode) await accept("，再$ui-ro");
  type("，请执行");
  assert.ok(editor().text.includes(`$${skillToken}`));
  if (!notionMode) assert.ok(editor().text.includes("$ui-router"));
  ctl("shot", "automatic-mixed");
  await submit(1, 1, notionMode ? 0 : 1);
  const firstUser = (await captures())[0].messages.filter(message => message.role === "user").at(-1);
  assert.ok(JSON.stringify(firstUser).includes(`$${skillToken}`));
  if (notionMode) {
    const calls = (await readFile(notionFixture.callsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(call => call.command === "list" && call.args.includes(fixtureDatabase)), "UI discovery must query the selected source database");
    assert.ok(calls.some(call => call.command === "read" && call.args.includes(notionFixture.skillRef)), "UI activation must read the selected page");
    assert.ok(calls.some(call => call.command === "export" && call.args.includes("s_" + "a".repeat(64))), "UI activation must export the pinned snapshot");
    const sessionFiles = (await readdir(join(base, "sessions"))).filter(name => name.endsWith(".jsonl"));
    const entries = (await Promise.all(sessionFiles.map(name => readFile(join(base, "sessions", name), "utf8")))).flatMap(body => body.trim().split("\n").map(JSON.parse));
    const loaded = entries.find(entry => entry.customType === "context-broker" && entry.details?.token === skillToken);
    assert.ok(loaded, "Submitted source selection must persist its actual load receipt");
    assert.equal(loaded.details.sourceId, "notion");
    assert.equal(loaded.details.recordId, "notion_page:" + notionFixture.skillRef.split("/")[2]);
    assert.equal(loaded.details.snapshotId, "s_" + "a".repeat(64));
    await writeFile(join(base, "notion-result.json"), JSON.stringify({ token: skillToken, sourceId: loaded.details.sourceId, pageId: loaded.details.recordId, snapshotId: loaded.details.snapshotId, identity: loaded.details.identity, commands: calls.map(call => call.command), fixture: true }, null, 2));
  }
  await accept(`$${skillPrefix}`); type("，再次调用"); await submit(2, 1, notionMode ? 0 : 1);
  await draft(`前文😀$${skillPrefix} tail`);
  for (let i = 0; i < 5; i++) key("left");
  key("escape"); key("ctrl+alt+shift+k");
  await until("manual picker", () => ctl("tree", "input").nodes.some(node => node.placeholder === "Search Context Broker content (insert token only)"));
  ctl("shot", "manual-picker");
  key("enter");
  await until("manual native replacement", () => editor()?.text === `前文😀$${manualSkillToken} tail`);
  assert.equal((await captures()).length, 2, "manual selection must not submit a prompt");
  ctl("shot", "manual-replacement");
  const cancelDraft = "$ui-";
  await draft(cancelDraft); key("escape"); key("ctrl+alt+shift+k");
  await until("cancel picker", () => ctl("tree", "input").nodes.length > 0);
  key("escape"); assert.equal(editor().text, cancelDraft);
  // The full tree keeps editor text separate from its prediction ghost child.
  const focusDraftText = () => nodes(ctl("tree")).find(node => node.class === "sf-ed-text")?.text ?? "";
  await draft(`$${skillPrefix}`);
  await until("automatic menu before manual focus check", () => focusDraftText() === `$${skillPrefix}` && ctl("tree", ".sf-overlay .sf-item").nodes.length > 0);
  key("escape");
  await until("automatic menu dismissed before manual focus check", () => ctl("tree", ".sf-overlay .sf-item").nodes.length === 0);
  key("ctrl+alt+shift+k");
  await until("picker before focus change", () => ctl("tree", "input").nodes.some(node => node.placeholder === "Search Context Broker content (insert token only)"));
  assert.equal(focusDraftText(), `$${skillPrefix}`, "Opening the manual picker must preserve the draft");
  const focusRect = editor().rect;
  ctl("click", String(focusRect[0] + Math.min(100, focusRect[2] / 2)), String(focusRect[1] + focusRect[3] / 2));
  await until("picker dismissed on focus change", () => ctl("tree", "input").nodes.length === 0);
  assert.equal(focusDraftText(), `$${skillPrefix}`);
  assert.equal((await captures()).length, 2);
  }
  console.log(`Native UI passed: ${upstreamMode ? "repository/Skill labels, exact Tab and Unicode manual selection, zero selection dispatch and one selected body" : catalogCacheFailureMode ? "persisted candidates before failed refresh, stable selected identity, zero selection dispatch, one selected body and usable cached next query" : catalogCacheMode ? "persisted candidates before delayed discovery, stable selected identity, zero selection dispatch, one selected body and refreshed next query" : collisionMode ? "same-name local/source candidates, local chip body without source reads, qualified remote body and actionable ambiguity rejection" : dependencyMode ? "missing source startup warning, ordinary chat, local autocomplete and manual picker, blocked unavailable selection" : loadingMode ? "65s cold dollar first-request/draft ordering, transcript Read persistence, warm reuse, cold slash, timeout and Escape/native Stop recovery, genuine model read, exact-session resume and shared-prefetch cancellation" : "clean Tern release install, automatic chips/caret clicks without dropdown/delete/undo/mixed submit/dedup, Unicode manual replacement, cancellation and focus dismissal"}. Evidence: ${base}`);
} catch (error) {
  if (loadingMode) {
    let result = {};
    try { result = JSON.parse(await readFile(join(base, "loading-result.json"), "utf8")); } catch {}
    await writeFile(join(base, "loading-result.json"), JSON.stringify({ ...result, status: "failed", error: error.message, providerRequests: (await captures()).length, evidence: base }, null, 2));
  }
  try {
    await writeFile(join(base,"failure-editor.json"),JSON.stringify({error:error.message,editor:editor(),tree:ctl("tree")},null,2));
    ctl("shot","failure");
  } catch (captureError) {
    await writeFile(join(base,"failure-capture.json"),JSON.stringify({error:error.message,captureError:captureError.message},null,2));
  }
  throw error;
} finally {
  try { if (tern && tern.exitCode === null && tern.signalCode === null) ctl("quit"); }
  catch {}
  const cleanupErrors = [];
  let ompExit;
  try {
    const identity = JSON.parse(await readFile(hostPid, "utf8"));
    try { ompExit = JSON.parse(await readFile(hostExit, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!ompExit) {
      // Identity comes only from this run's launcher while its Tern window is owned.
      try { process.kill(-identity.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await until("owned OMP close receipt", async () => { try { ompExit = JSON.parse(await readFile(hostExit, "utf8")); return ompExit.observedExit; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }, 10_000);
    }
  } catch (error) { cleanupErrors.push(error.message); }
  try { await stop(tern); } catch (error) { cleanupErrors.push(error.message); }
  try { await stop(daemon); } catch (error) { cleanupErrors.push(error.message); }
  const stopped = cleanupErrors.length === 0 && ompExit?.observedExit === true && [tern, daemon].every(child => !child || child.exitCode !== null || child.signalCode !== null);
  await writeFile(processFile, JSON.stringify(ownedProcesses, null, 2) + "\n");
  await writeFile(join(base, "cleanup.json"), JSON.stringify({ stopped, ompExit, errors: cleanupErrors, processes: ownedProcesses }, null, 2) + "\n");
  if (!stopped) process.exitCode = 1;
  console.log(`Native UI fixtures retained: ${base}`);
}
