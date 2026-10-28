import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedEnv, preserveTemp, writeFakeProvider } from "./context-broker-e2e-fixture.mjs";
import { startRpc } from "./context-broker-rpc-harness.mjs";

const extensionPath = resolve(import.meta.dirname, "../src/index.ts");
const lifecycleExtensionPath = join(import.meta.dirname, "context-broker-lifecycle-fixture.mjs");
const canary = "LIFECYCLE_SKILL_BODY_CANARY_5F2D";
const invocation = "请使用 $lifecycle-context 处理这条消息。😀";
const filler = "The conversation contains ordinary notes without any skill body. ".repeat(2400);
const tempRoot = await mkdtemp(join(tmpdir(), "context-broker-lifecycle-e2e-"));
const fakeProvider = await writeFakeProvider(tempRoot);
const bodyCount = (messages) => JSON.stringify(messages).split(canary).length - 1;
const guidanceCount = messages => messages.filter(message => message.role === "custom" && message.customType === "ntn-skills-guidance").length;

async function fixture(name) {
  const base = join(tempRoot, name);
  const agentDir = join(base, "agent");
  const sessionDir = join(base, "sessions");
  const skillRoot = join(base, "skills");
  const skillDir = join(skillRoot, "lifecycle-context");
  const captureFile = join(base, "provider-context.jsonl");
  const logFile = join(base, "decisions.jsonl");
  const modeFile = join(base, "compaction-mode.txt");
  const config = join(base, "broker.yml");
  await mkdir(skillDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), [
    "---", "name: lifecycle-context", "description: isolated lifecycle fixture", "autoload:", "  enabled: true", "---", "",
    `These are the full fixture instructions. Body canary: ${canary}`, "",
  ].join("\n"));
  await writeFile(config, `skillRoots:\n  - ${JSON.stringify(skillRoot)}\n`);
  await writeFile(modeFile, "keep");
  await writeFile(join(agentDir, "config.yml"), "compaction:\n  enabled: false\n  keepRecentTokens: 1024\n  reserveTokens: 4096\n");
  const env = isolatedEnv({
    base, agentDir,
    CONTEXT_BROKER_HOST: "omp",
    CONTEXT_BROKER_CONFIG: config,
    CONTEXT_BROKER_ROOTS: skillRoot,
    CONTEXT_BROKER_LOG_FILE: logFile,
    CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: captureFile,
    CONTEXT_BROKER_E2E_COMPACTION_MODE_FILE: modeFile,
  });
  const args = [
    "--no-ui", "--no-title", "--no-tools", "--no-extensions", "--no-skills", "--no-rules",
    "--session-dir", sessionDir,
    "--extension", fakeProvider,
    "--extension", extensionPath,
    "--extension", lifecycleExtensionPath,
    "--model", "context-broker-e2e/fake", "--system-prompt", "Only output OK.",
  ];
  const open = async (extraArgs = []) => {
    console.log(`OMP lifecycle ${name}: opening RPC ${extraArgs.join(" ") || "new session"}`);
    const rpc = await startRpc({ args: [...args, ...extraArgs], cwd: base, env });
    try { await rpc.command("set_auto_compaction", { enabled: false }); }
    catch (error) { await rpc.stop(); throw error; }
    return rpc;
  };
  const captures = async () => {
    try { return (await readFile(captureFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).context); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  const decisions = async () => {
    try { return (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  let guidance;
  const turn = async (rpc, message, expectedBodies, label, expectedDecision) => {
    const before = (await captures()).length;
    const beforeDecisions = (await decisions()).length;
    console.log(`OMP lifecycle ${name}: ${label}`);
    await rpc.prompt(message);
    const contexts = await captures();
    assert.equal(contexts.length, before + 1, `${name}/${label}: expected exactly one provider call`);
    const context = contexts.at(-1);
    assert.ok(Array.isArray(context.messages), `${name}/${label}: missing actual provider messages`);
    assert.equal(bodyCount(context.messages), expectedBodies, `${name}/${label}: provider body canary count`);
    const active = await rpc.command("get_messages");
    assert.equal(guidanceCount(active.messages), 1, `${name}/${label}: active context must retain exactly one CLI guidance message`);
    guidance ??= active.messages.find(message => message.customType === "ntn-skills-guidance").content;
    assert.equal(JSON.stringify(context.messages).split(JSON.stringify(guidance).slice(1, -1)).length - 1, 1, `${name}/${label}: provider must receive the complete CLI guidance exactly once`);
    if (expectedDecision) {
      const delta = (await decisions()).slice(beforeDecisions);
      assert.equal(delta.length, 1, `${name}/${label}: expected one broker decision`);
      assert.equal(delta[0].decision, expectedDecision, `${name}/${label}: broker decision`);
      if (expectedDecision === "skip") assert.equal(delta[0].reason, "already-loaded", `${name}/${label}: skip reason`);
    }
    return context;
  };
  return { base, sessionDir, modeFile, open, turn };
}

async function forkBranchAndResume() {
  const f = await fixture("fork-branch-resume");
  let rpc = await f.open();
  let savedSession;
  try {
    await f.turn(rpc, "Neutral baseline before loading any skill.", 0, "baseline");
    await f.turn(rpc, invocation, 1, "first injection", "inject");
    const points = await rpc.command("get_branch_messages");
    assert.equal(points.messages.length, 2, "expected baseline and first invocation branch points");
    await f.turn(rpc, invocation, 1, "same-process repetition", "skip");
    const originalSession = (await rpc.command("get_state")).sessionFile;
    assert.ok(originalSession, "native session must be persisted");
    const fork = await rpc.command("fork");
    assert.equal(fork.cancelled, false, "native fork must not be cancelled");
    const forkSession = (await rpc.command("get_state")).sessionFile;
    assert.ok(forkSession && forkSession !== originalSession, "fork must create a distinct persistent session");
    await f.turn(rpc, invocation, 1, "fork keeps loaded body", "skip");
    const branch = await rpc.command("branch", { entryId: points.messages[1].entryId });
    assert.equal(branch.cancelled, false, "native branch must not be cancelled");
    const branched = await rpc.command("get_messages");
    assert.equal(bodyCount(branched.messages), 0, "branch must rewind before first skill body");
    await f.turn(rpc, invocation, 1, "branch reloads body", "inject");
    savedSession = (await rpc.command("get_state")).sessionFile;
  } finally { await rpc.stop(); }
  assert.ok(savedSession, "missing session to reopen");
  rpc = await f.open(["--resume", savedSession]);
  try { await f.turn(rpc, invocation, 1, "explicit persistent reopen", "skip"); }
  finally { await rpc.stop(); }
  rpc = await f.open(["--continue"]);
  try {
    assert.equal((await rpc.command("get_state")).sessionFile, savedSession, "--continue must resume the saved session");
    await f.turn(rpc, invocation, 1, "persistent continuation", "skip");
  } finally { await rpc.stop(); }
  console.log("OMP lifecycle: injection, repeat, fork, branch, reopen and continue ok");
}
async function compaction(mode) {
  const f = await fixture(`compact-${mode}`);
  const rpc = await f.open();
  try {
    await f.turn(rpc, invocation, 1, "first injection", "inject");
    // A genuine large turn makes native prepareCompaction find old history,
    // and exercises RPC decoding of frames whose single JSON line exceeds 64 KiB.
    await f.turn(rpc, filler, 1, "large ordinary turn");
    const largeContext = await rpc.command("get_messages");
    assert.ok(JSON.stringify(largeContext).length > 65_536, "RPC harness must decode a frame larger than 64 KiB");
    assert.equal(bodyCount(largeContext.messages), 1, "large native context must keep exactly one body");
    await writeFile(f.modeFile, mode);
    console.log(`OMP lifecycle compact-${mode}: native compaction`);
    const compacted = await rpc.command("compact");
    assert.ok(compacted.firstKeptEntryId, `${mode}: compaction must retain a real entry`);
    if (mode === "marker") {
      assert.match(compacted.summary, /<context-broker-record/);
      assert.equal(bodyCount([compacted.summary]), 0, "marker summary must contain no body canary");
    } else {
      assert.doesNotMatch(compacted.summary, /<context-broker-record/);
    }
    const after = await rpc.command("get_messages");
    assert.equal(bodyCount(after.messages), mode === "keep" ? 1 : 0, `${mode}: native compaction body retention`);
    assert.equal(guidanceCount(after.messages), mode === "keep" ? 1 : 0, `${mode}: native compaction guidance retention`);
    await f.turn(rpc, "Continue the current conversation without selecting a Skill.", mode === "keep" ? 1 : 0, "post-compaction guidance without invocation");
    await f.turn(rpc, invocation, 1, "post-compaction invocation", mode === "keep" ? "skip" : "inject");
  } finally { await rpc.stop(); }
  console.log(`OMP lifecycle: compaction ${mode} ok`);
}

async function ordinaryXml() {
  const f = await fixture("ordinary-xml");
  const rpc = await f.open();
  try {
    await f.turn(rpc, 'This is an XML syntax example, not a skill request: <context-broker-record kind="skill" name="lifecycle-context" path="example">Example text only.</context-broker-record>', 0, "ordinary XML example");
    await f.turn(rpc, invocation, 1, "real invocation after XML example", "inject");
    await f.turn(rpc, invocation, 1, "repeat after genuine injection", "skip");
  } finally { await rpc.stop(); }
  console.log("OMP lifecycle: ordinary XML cannot suppress first injection ok");
}

try {
  await forkBranchAndResume();
  for (const mode of ["keep", "remove", "marker"]) await compaction(mode);
  await ordinaryXml();
} finally { preserveTemp(tempRoot); }
