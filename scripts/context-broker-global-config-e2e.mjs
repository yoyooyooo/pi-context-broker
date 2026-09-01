import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const extensionPath = join(repoRoot, "src/index.ts");
const HOST_TIMEOUT_MS = 20_000;

function runCommand(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref?.();
      reject(new Error(`${file} timed out after ${HOST_TIMEOUT_MS}ms: ${args.join(" ")}`));
    }, HOST_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolve(result);
      } else {
        const error = new Error(`${file} exited with code ${code}: ${args.join(" ")}`);
        Object.assign(error, result, { code });
        reject(error);
      }
    });
  });
}

async function writeFakeProvider(base) {
  const path = join(base, "fake-provider.mjs");
  await writeFile(path, `
function makeStream(model) {
  const output = {
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: model.api || "context-broker-config-e2e-api",
    provider: model.provider || "context-broker-config-e2e",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const events = [
    { type: "start", partial: output },
    { type: "text_start", contentIndex: 0, partial: output },
    { type: "text_delta", contentIndex: 0, delta: "OK", partial: output },
    { type: "text_end", contentIndex: 0, content: "OK", partial: output },
    { type: "done", reason: "stop", message: output },
  ];
  let sent = false;
  return {
    push() {},
    end() {},
    result: async () => output,
    async *[Symbol.asyncIterator]() {
      if (sent) return;
      sent = true;
      for (const event of events) yield event;
    },
  };
}

export default function fakeProvider(pi) {
  pi.registerProvider("context-broker-config-e2e", {
    name: "Context Broker Config E2E Fake Provider",
    api: "context-broker-config-e2e-api",
    apiKey: "fake",
    baseUrl: "http://127.0.0.1",
    streamSimple: makeStream,
    models: [{
      id: "fake",
      name: "Fake",
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 4096,
    }],
  });
}
`);
  return path;
}

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
      else if (entry.isFile() && entry.name.includes(".jsonl")) result.push(child);
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

function cleanEnv(agentDir, logFile) {
  const env = {
    ...process.env,
    HOME: dirname(agentDir),
    PI_CODING_AGENT_DIR: agentDir,
    CONTEXT_BROKER_LOG_FILE: logFile,
  };
  delete env.CONTEXT_BROKER_CONFIG;
  delete env.CONTEXT_BROKER_ROOTS;
  delete env.CONTEXT_BROKER_HOST;
  delete env.CONTEXT_BROKER_REQUIRE_ENABLED;
  delete env.CONTEXT_BROKER_DISCOVERY_CATALOGS;
  return env;
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
  const sessionDir = join(base, "sessions");
  const logFile = join(base, "decisions.jsonl");
  await mkdir(join(configDir, "rules"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const firstPath = await writeSkill(skillRoot, "first", "first-context", "first fixture context", "FIRST_CONTEXT_MARKER");
  const secondPath = await writeSkill(skillRoot, "second", "second-context", "second fixture context", "SECOND_CONTEXT_MARKER");
  await writeFile(join(configDir, "config.yml"), `skillRoots:\n  - ${JSON.stringify(skillRoot)}\n`);
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
    "--session-dir",
    sessionDir,
    "--no-tools",
    "--extension",
    fakeProviderPath,
    "--extension",
    extensionPath,
    "--model",
    "context-broker-config-e2e/fake",
    "--system-prompt",
    "Only output OK.",
  ];
  if (host === "omp") commonArgs.splice(4, 0, "--no-title");

  const env = cleanEnv(agentDir, logFile);
  const first = await runCommand(host, [...commonArgs, "load first"], { cwd: base, env });
  assert.match(first.stdout, /OK/, `${host}: configured rule turn did not return OK`);
  const second = await runCommand(host, [...commonArgs, "--continue", "$second-context"], { cwd: base, env });
  assert.match(second.stdout, /OK/, `${host}: dollar turn did not return OK`);

  assert.equal(existsSync(logFile), true, `${host}: missing decision log`);
  const logLines = (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(logLines.length, 2, `${host}: expected two injection decisions`);
  assert.equal(logLines[0].decision, "inject", `${host}: first decision should inject`);
  assert.equal(logLines[0].record?.name, "first-context", `${host}: first decision target mismatch`);
  assert.equal(logLines[1].decision, "inject", `${host}: second decision should inject`);
  assert.equal(logLines[1].record?.name, "second-context", `${host}: second decision target mismatch`);

  const sessionFiles = await waitForJsonlFiles(sessionDir, 1);
  assert.ok(sessionFiles.length >= 1, `${host}: expected session file output`);
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
  if (process.env.CONTEXT_BROKER_KEEP_E2E_TEMP !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.log(`kept temp: ${tempRoot}`);
  }
}
