import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedEnv, preserveTemp, runCommand, writeFakeProvider } from "./context-broker-e2e-fixture.mjs";
import { startRpc } from "./context-broker-rpc-harness.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const extensionPath = join(repoRoot, "src/index.ts");

async function writeSkill(skillRoot) {
  const designContextDir = join(skillRoot, "design-context");
  await mkdir(designContextDir, { recursive: true });
  await writeFile(join(designContextDir, "SKILL.md"), [
    "---",
    "name: design-context",
    "description: test fixture design-context skill",
    "autoload:",
    "  enabled: true",
    "  aliases:",
    "    - 设计上下文",
    "---",
    "",
    "Design context marker: CONTEXT_BROKER_E2E_MARKER",
    "",
  ].join("\n"));

  const reviewDir = join(skillRoot, "review-context");
  await mkdir(reviewDir, { recursive: true });
  await writeFile(join(reviewDir, "SKILL.md"), [
    "---",
    "name: review-context",
    "description: test fixture review context skill",
    "autoload:",
    "  enabled: true",
    "  aliases:",
    "    - 设计评审",
    "---",
    "",
    "Review marker: CONTEXT_BROKER_E2E_REVIEW_MARKER",
    "",
  ].join("\n"));
}

async function findJsonlFiles(dir) {
  const result = [];
  async function walk(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(child);
      }
    }
  }
  await walk(dir);
  return result.sort();
}

async function runHost(host, tempRoot, fakeProviderPath) {
  const base = join(tempRoot, host);
  const skillRoot = join(base, "fixture-skills");
  const agentDir = join(base, "agent");
  const sessionDir = join(base, "sessions");
  const logFile = join(base, "decisions.jsonl");
  const providerContextFile = join(base, "provider-context.jsonl");
  const configDir = join(base, "context-broker");
  const configFile = join(configDir, "config.yml");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(join(configDir, "rules"), { recursive: true });
  await writeSkill(skillRoot);
  await writeFile(configFile, `skillRoots:\n  - ${JSON.stringify(skillRoot)}\n`);
  await writeFile(join(configDir, "rules", "architecture.yml"), [
    "id: architecture-high-level-review",
    "inject:",
    "  - design-context",
    "  - review-context",
    "match:",
    "  - exact:",
    "      - 设计上下文架构评审",
  ].join("\n"));

  const commonArgs = [
    "-p",
    "--no-extensions",
    "--no-skills",
    "--session-dir",
    sessionDir,
    "--no-tools",
    "--extension",
    fakeProviderPath,
    "--extension",
    extensionPath,
    "--model",
    "context-broker-e2e/fake",
    "--system-prompt",
    "Only output OK.",
  ];
  if (host === "omp") commonArgs.push("--no-title", "--no-rules");

  const env = isolatedEnv({
    base,
    agentDir,
    CONTEXT_BROKER_ROOTS: skillRoot,
    CONTEXT_BROKER_CONFIG: configFile,
    CONTEXT_BROKER_LOG_FILE: logFile,
    CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerContextFile,
  });
  const run = async (prompt, continued = false) => {
    const resume = continued ? ["--continue"] : [];
    if (host === "pi") return runCommand(host, [...commonArgs, ...resume, prompt], { cwd: base, env });
    const rpc = await startRpc({ host, args: [...commonArgs.filter(arg => arg !== "-p"), "--no-ui", ...resume], cwd: base, env });
    try {
      await rpc.prompt(prompt);
      return { stdout: (await rpc.command("get_last_assistant_text")).text ?? "" };
    } finally { await rpc.stop(); }
  };

  const prompt = "中文😀先使用$design-context，再用$review-context。请一起评审";
  console.log(`${host} host e2e: first user turn`);
  const first = await run(prompt);
  assert.match(first.stdout, /OK/, `${host}: first turn did not return OK`);

  console.log(`${host} host e2e: continued user turn`);
  const second = await run(prompt, true);
  assert.match(second.stdout, /OK/, `${host}: second turn did not return OK`);

  const logText = await readFile(logFile, "utf8");
  const logLines = logText.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(logLines.length, 3, `${host}: expected one inject and two already-loaded skip lines`);
  assert.equal(logLines[0].decision, "inject", `${host}: first decision should inject`);
  assert.equal(logLines[0].action, "inject", `${host}: first action should inject`);
  assert.deepEqual(logLines[0].records.map((skill) => skill.name), ["design-context", "review-context"], `${host}: first decision should inject both skills`);
  assert.equal(logLines[1].decision, "skip", `${host}: second decision should skip design-context`);
  assert.equal(logLines[1].reason, "already-loaded", `${host}: second design-context skip reason should be already-loaded`);
  assert.equal(logLines[2].decision, "skip", `${host}: second decision should skip review skill`);
  assert.equal(logLines[2].reason, "already-loaded", `${host}: second review skip reason should be already-loaded`);

  const sessionFiles = await findJsonlFiles(sessionDir);
  assert.equal(sessionFiles.length, 1, `${host}: expected one session file`);
  const sessionText = await readFile(sessionFiles[0], "utf8");
  const guidanceEntries = sessionText.trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "custom_message" && entry.customType === "ntn-skills-guidance");
  assert.equal(guidanceEntries.length, 1, `${host}: continued session must retain one CLI guidance message`);
  const guidance = JSON.stringify(guidanceEntries[0].content).slice(1, -1);
  const customMatches = sessionText.match(/"customType":"context-broker"/g) ?? [];
  const markerMatches = sessionText.match(/CONTEXT_BROKER_E2E_MARKER/g) ?? [];
  const reviewMarkerMatches = sessionText.match(/CONTEXT_BROKER_E2E_REVIEW_MARKER/g) ?? [];
  assert.equal(customMatches.length, 1, `${host}: expected one context-broker custom message`);
  assert.equal(markerMatches.length, 1, `${host}: expected one injected skill marker`);
  assert.equal(reviewMarkerMatches.length, 1, `${host}: expected one injected review skill marker`);
  assert.match(sessionText, /"records":\[/, `${host}: expected multi-record details`);

  const providerContextText = await readFile(providerContextFile, "utf8");
  const providerContexts = providerContextText.trim().split("\n").map(line => JSON.parse(line).context);
  assert.equal(providerContexts.length, 2, `${host}: expected two provider context captures`);
  for (const [turn, context] of providerContexts.entries()) {
    const messages = JSON.stringify(context.messages);
    assert.equal(messages.split(guidance).length - 1, 1, `${host}: turn ${turn + 1} must contain the complete CLI guidance exactly once`);
    for (const marker of ["CONTEXT_BROKER_E2E_MARKER", "CONTEXT_BROKER_E2E_REVIEW_MARKER"]) {
      assert.equal(messages.split(marker).length - 1, 1, `${host}: turn ${turn + 1} provider messages must contain exactly one ${marker} body`);
    }
  }

  return { host, sessionFile: sessionFiles[0], logFile, providerContextFile };
}

const tempRoot = await mkdtemp(join(tmpdir(), "context-broker-host-e2e-"));

try {
  const fakeProviderPath = await writeFakeProvider(tempRoot);
  const hosts = process.argv.slice(2);
  const selectedHosts = hosts.length > 0 ? hosts : ["omp", "pi"];
  const results = [];
  for (const host of selectedHosts) {
    if (host !== "omp" && host !== "pi") throw new Error(`Unsupported host: ${host}`);
    results.push(await runHost(host, tempRoot, fakeProviderPath));
  }
  for (const result of results) {
    console.log(`${result.host} host e2e ok: ${result.sessionFile}`);
  }
} finally {
  preserveTemp(tempRoot);
}
