import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isolatedEnv, preserveTemp, runCommand, writeFakeProvider } from "./context-broker-e2e-fixture.mjs";
import { startRpc } from "./context-broker-rpc-harness.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const extensionPath = join(repoRoot, "src/index.ts");

async function writeSkill(skillRoot, dir, name, description, body) {
  const skillDir = join(skillRoot, dir);
  await mkdir(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  await writeFile(path, [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "autoload:",
    "  enabled: true",
    "---",
    "",
    body,
    "",
  ].join("\n"));
  return path;
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
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(child);
    }
  }
  await walk(dir);
  return result.sort();
}

async function waitForJsonlFiles(dir, count, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  let files = await findJsonlFiles(dir);
  while (files.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    files = await findJsonlFiles(dir);
  }
  return files;
}

function cleanEnv(agentDir, logFile, providerContextFile) {
  return isolatedEnv({
    base: dirname(agentDir),
    agentDir,
    CONTEXT_BROKER_LOG_FILE: logFile,
    CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerContextFile,
  });
}

function parseSessionEntries(text) {
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function contextBrokerEntries(entries) {
  return entries.filter((entry) => {
    if (entry.type === "custom_message" && entry.customType === "context-broker") return true;
    if (entry.type === "message" && entry.message?.role === "custom" && entry.message?.customType === "context-broker") return true;
    return false;
  });
}

async function runHost(host, tempRoot, fakeProviderPath) {
  const base = join(tempRoot, host);
  const agentDir = join(base, "agent");
  const configDir = join(agentDir, "context-broker");
  const skillRoot = join(base, "skills");
  const shadowedRoot = join(base, "source-skills");
  const sessionDir = join(base, "sessions");
  const logFile = join(base, "decisions.jsonl");
  const providerContextFile = join(base, "provider-context.jsonl");
  await mkdir(join(configDir, "rules"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const firstPath = await writeSkill(skillRoot, "first", "first-context", "first fixture context", "FIRST_CONTEXT_MARKER");
  const secondPath = await writeSkill(skillRoot, "second", "second-context", "second fixture context", "SECOND_CONTEXT_MARKER");
  await writeSkill(shadowedRoot, "first", "first-context", "shadowed first context", "SHADOWED_FIRST_MARKER");
  await writeSkill(shadowedRoot, "second", "second-context", "shadowed second context", "SHADOWED_SECOND_MARKER");
  await writeFile(join(configDir, "config.yml"), `skillRoots:\n  - ${JSON.stringify(skillRoot)}\n  - ${JSON.stringify(shadowedRoot)}\n`);
  await writeFile(join(configDir, "rules", "first.yml"), [
    "id: first-rule",
    "inject:",
    "  - first-context",
    "match:",
    "  - exact:",
    "      - load first",
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

  const env = cleanEnv(agentDir, logFile, providerContextFile);
  // A directory override must not switch this process's native prompt protocol.
  env.CONTEXT_BROKER_HOST = host === "pi" ? "omp" : "pi";
  const run = async (prompt, continued = false) => {
    const resume = continued ? ["--continue"] : [];
    if (host === "pi") return runCommand(host, [...commonArgs, ...resume, prompt], { cwd: base, env });
    const rpc = await startRpc({ host, args: [...commonArgs.filter(arg => arg !== "-p"), "--no-ui", ...resume], cwd: base, env });
    try {
      await rpc.prompt(prompt);
      return { stdout: (await rpc.command("get_last_assistant_text")).text ?? "" };
    } finally { await rpc.stop(); }
  };
  console.log(`${host} config e2e: configured rule user turn`);
  const first = await run("load first");
  assert.match(first.stdout, /OK/, `${host}: configured rule turn did not return OK`);
  console.log(`${host} config e2e: continued dollar user turn`);
  const second = await run("$second-context@local", true);
  assert.match(second.stdout, /OK/, `${host}: dollar turn did not return OK`);

  assert.equal(existsSync(logFile), true, `${host}: missing decision log`);
  const logLines = (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(logLines.length, 2, `${host}: expected two injection decisions`);
  assert.equal(logLines[0].decision, "inject", `${host}: first decision should inject`);
  assert.equal(logLines[0].record?.name, "first-context", `${host}: first decision target mismatch`);
  assert.equal(logLines[1].decision, "inject", `${host}: second decision should inject`);
  assert.equal(logLines[1].record?.name, "second-context", `${host}: second decision target mismatch`);

  const sessionFiles = await waitForJsonlFiles(sessionDir, 1);
  assert.equal(sessionFiles.length, 1, `${host}: expected one persistent session file`);
  const sessionText = (await Promise.all(sessionFiles.map((file) => readFile(file, "utf8")))).join("\n");
  const entries = contextBrokerEntries(parseSessionEntries(sessionText));
  assert.equal(entries.length, 2, `${host}: expected two context-broker custom messages`);
  const injectedContent = entries.map((entry) => String(entry.content ?? entry.message?.content ?? "")).join("\n");
  assert.match(injectedContent, /<context-broker-record kind="skill" name="first-context"/, `${host}: missing first injected block`);
  assert.match(injectedContent, /<context-broker-record kind="skill" name="second-context"/, `${host}: missing second injected block`);
  assert.match(injectedContent, /FIRST_CONTEXT_MARKER/, `${host}: missing first marker`);
  assert.match(injectedContent, /SECOND_CONTEXT_MARKER/, `${host}: missing second marker`);
  const firstDetails = entries[0].details ?? entries[0].message?.details ?? {};
  const secondDetails = entries[1].details ?? entries[1].message?.details ?? {};
  assert.equal(firstDetails.path, "~/skills/first/SKILL.md", `${host}: first path mismatch`);
  assert.equal(secondDetails.path, "~/skills/second/SKILL.md", `${host}: second path mismatch`);

  const contexts = (await readFile(providerContextFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line).context);
  assert.equal(contexts.length, 2, `${host}: expected two provider captures`);
  for (const [index, context] of contexts.entries()) {
    const messages = JSON.stringify(context.messages);
    assert.equal(messages.split("FIRST_CONTEXT_MARKER").length - 1, 1, `${host}: turn ${index + 1} must include first body exactly once`);
    assert.equal(messages.split("SECOND_CONTEXT_MARKER").length - 1, index, `${host}: turn ${index + 1} second body count`);
    assert.doesNotMatch(messages, /SHADOWED_(FIRST|SECOND)_MARKER/, `${host}: a later root must not supply either Skill body`);
  }

  return { host, sessionFile: sessionFiles[0] };
}

const tempRoot = await mkdtemp(join(tmpdir(), "context-broker-config-e2e-"));

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
    console.log(`${result.host} config e2e ok: ${result.sessionFile}`);
  }
} finally {
  preserveTemp(tempRoot);
}
