import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
import { appendFileSync } from "node:fs";

function makeStream(model, context) {
  if (process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE) {
    appendFileSync(
      process.env.CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE,
      JSON.stringify({ model: model.id, context }) + "\\n",
    );
  }
  const output = {
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: model.api || "context-broker-e2e-api",
    provider: model.provider || "context-broker-e2e",
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
  pi.registerProvider("context-broker-e2e", {
    name: "Context Broker E2E Fake Provider",
    api: "context-broker-e2e-api",
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
  if (host === "omp") commonArgs.splice(4, 0, "--no-title");

  const env = {
    ...process.env,
    HOME: base,
    PI_CODING_AGENT_DIR: agentDir,
    CONTEXT_BROKER_ROOTS: skillRoot,
    CONTEXT_BROKER_CONFIG: configFile,
    CONTEXT_BROKER_LOG_FILE: logFile,
    CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: providerContextFile,
  };

  const prompt = "$design-context，$review-context。请一起评审";
  const first = await runCommand(host, [...commonArgs, prompt], { cwd: base, env });
  assert.match(first.stdout, /OK/, `${host}: first turn did not return OK`);

  const second = await runCommand(host, [...commonArgs, "--continue", prompt], { cwd: base, env });
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
  assert.match(
    JSON.stringify(providerContexts[0]),
    /CONTEXT_BROKER_E2E_MARKER/,
    `${host}: provider context must include design-context skill body`,
  );
  assert.match(
    JSON.stringify(providerContexts[0]),
    /CONTEXT_BROKER_E2E_REVIEW_MARKER/,
    `${host}: provider context must include review skill body`,
  );

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
  if (process.env.CONTEXT_BROKER_KEEP_E2E_TEMP !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.log(`kept temp: ${tempRoot}`);
  }
}
