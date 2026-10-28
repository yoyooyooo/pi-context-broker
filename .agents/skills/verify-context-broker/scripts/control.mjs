#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnv, signalHost, spawnHost } from "../../../../packages/context-broker/scripts/context-broker-e2e-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const routes = {
  injection: { tools: ["bun", "omp", "pi"], scripts: ["packages/context-broker/scripts/context-broker-host-e2e.mjs", "packages/context-broker/scripts/context-broker-global-config-e2e.mjs"] },
  editor: { tools: ["bun", "omp", "tern", "tar"], scripts: ["scripts/verify-native-ui.mjs"], artifacts: ["packages/tern-context-broker/query/completion.mjs"] },
  lifecycle: { tools: ["bun", "omp"], scripts: ["packages/context-broker/scripts/context-broker-lifecycle-e2e.mjs"] },
  model: { tools: ["bun", "omp"], scripts: ["scripts/verify-real-model.mjs"] },
  distribution: { tools: ["bun", "omp", "npm", "git", "tar"], scripts: ["scripts/verify-artifacts.mjs", "scripts/release.test.mjs"] },
  source: { tools: ["bun", "omp", "pi"], scripts: ["scripts/verify-notion-integration.mjs"] },
  "notion-editor": { tools: ["bun", "omp", "tern", "tar"], scripts: ["scripts/verify-native-ui.mjs --notion"], artifacts: ["packages/tern-context-broker/query/completion.mjs"] },
  'tern-pi': { tools: ['node', 'pi', 'tern'], scripts: ['scripts/verify-tern-surfaces.mjs probe --surface pi-terminal'] },
  'tern-omp-terminal': { tools: ['node', 'omp', 'tern'], scripts: ['scripts/verify-tern-surfaces.mjs probe --surface omp-terminal'] },
  'tern-omp-native': { tools: ['node', 'omp', 'tern'], scripts: ['scripts/verify-tern-surfaces.mjs probe --surface omp-native'] },
};
const [action, target] = process.argv.slice(2);
const usage = "Usage: node .agents/skills/verify-context-broker/scripts/control.mjs doctor|run injection|editor|lifecycle|model|distribution|source|notion-editor|tern-pi|tern-omp-terminal|tern-omp-native\n       node .agents/skills/verify-context-broker/scripts/control.mjs evidence /absolute/run-directory\nTern routes perform no-product renderer probes. Frozen acceptance: node scripts/verify-tern-surfaces.mjs run --surface SURFACE --spec /absolute/owned-run.json";
if (["help", "--help", "-h"].includes(action)) { console.log(usage); process.exit(0); }
const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split(".").map(Number);
const supportedNode = (nodeMajor === 22 && (nodeMinor > 22 || (nodeMinor === 22 && nodePatch >= 3))) || nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 20);
if (process.versions.bun || !supportedNode) throw new Error("Run this helper with Node.js 22.22.3+ within 22.x or 24.20.0+; Bun is build-only.");
if (process.argv.length !== 4 || !["doctor", "run", "evidence"].includes(action) || (action !== "evidence" && !routes[target])) throw new Error(usage);

async function executable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(directory || ".", name);
    try { await access(path, constants.X_OK); return await realpath(path); }
    catch (error) { if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error; }
  }
  throw new Error(`${name} is not executable on PATH`);
}

async function version(name) {
  const host = name === "omp" || name === "pi";
  const child = host
    ? await spawnHost(name, ["--version"], { cwd: root, env: isolatedEnv({ base: doctorBase, agentDir: join(doctorBase, "agent") }), stdio: ["ignore", "pipe", "pipe"] })
    : spawn(await executable(name), ["--version"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  return await new Promise((accept, reject) => {
    let stdout = "";
    let timedOut = false;
    let escalation;
    const timer = setTimeout(() => {
      timedOut = true;
      if (host) signalHost(child, "SIGTERM"); else child.kill("SIGTERM");
      escalation = setTimeout(() => { if (host) signalHost(child, "SIGKILL"); else child.kill("SIGKILL"); }, 2_000);
    }, 10_000);
    child.stdout.on("data", data => { stdout += data; });
    child.on("error", error => { clearTimeout(timer); clearTimeout(escalation); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation);
      if (timedOut || code !== 0) reject(new Error(`${name} version probe failed: ${timedOut ? "timeout" : code ?? signal}`));
      else accept({ name, file: child.spawnfile, args: child.spawnargs.slice(1), version: stdout.trim() });
    });
    child.stderr.resume();
  });
}

let doctorBase;
async function doctor(feature) {
  const report = { feature, root, platform: process.platform, node: { file: process.execPath, version: process.versions.node }, tools: [], artifacts: [], failures: [], authentication: feature === "model" ? "not probed; existing magpie login is required by the run" : feature === "editor" ? "existing Tern OS sign-in; fixture provider requires no model credentials" : "not required for fake-provider CLI runs" };
  doctorBase = await mkdtemp(join(tmpdir(), "broker-doctor-"));
  report.scratch = doctorBase;
  report.scratchDisposition = "retained; move this owned directory to system Trash after reviewing doctor output";
  for (const name of routes[feature].tools) {
    try { report.tools.push(await version(name)); }
    catch (error) { report.failures.push(error.message); }
  }
  for (const path of routes[feature].artifacts ?? []) {
    try {
      await access(join(root, path), path.endsWith("/ntn-skills.mjs") ? constants.R_OK : constants.X_OK);
      const body = await readFile(join(root, path));
      report.artifacts.push({ path, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    } catch { report.failures.push(`${path} is missing or not executable; run bun run build`); }
  }
  if (["editor", "notion-editor"].includes(feature) && process.platform !== "darwin") report.failures.push("The native editor runner currently requires macOS.");
  report.status = report.failures.length ? "blocked" : "ready";
  return report;
}

const retainedPattern = /(?:E2E evidence retained: |Native UI fixtures retained: |Real-model evidence retained: |Artifact workspace retained: |Release fixture retained at |Notion integration evidence retained: |Builtin management evidence retained: |Builtin UI evidence retained: |Tern surface evidence retained: )([^\r\n]+)/g;
async function runScript(script, directory, index) {
  const args = script === "scripts/release.test.mjs" ? ["--test", script] : script.split(" ");
  const transcript = `${index + 1}-${script.split("/").at(-1)}.log`;
  const log = join(directory, transcript);
  await writeFile(log, "");
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let writes = Promise.resolve();
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on("data", data => {
      destination.write(data);
      writes = writes.then(() => appendFile(log, data));
    });
  }
  const result = await new Promise(accept => {
    child.on("error", error => accept({ exitCode: null, signal: null, error: error.message }));
    child.on("close", (exitCode, signal) => accept({ exitCode, signal }));
  });
  await writes;
  const output = await readFile(log, "utf8");
  return { command: [process.execPath, ...args], startedAt, finishedAt: new Date().toISOString(), transcript, ...result, evidenceDirectories: [...new Set([...output.matchAll(retainedPattern)].map(match => match[1].trim()))] };
}

async function evidence(directory) {
  if (!isAbsolute(directory)) throw new Error("Evidence directory must be absolute.");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const preserved = [];
  for (const command of manifest.commands) {
    await access(join(directory, command.transcript));
    for (const path of command.evidenceDirectories) {
      if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error(`Missing evidence directory: ${path}`);
      preserved.push(path);
    }
  }
  if (manifest.status !== "passed" || manifest.commands.length !== routes[manifest.feature]?.scripts.length || manifest.commands.some(command => command.exitCode !== 0 || command.signal)) throw new Error(`Run did not pass all mapped commands: ${directory}`);
  if (!preserved.length) throw new Error("No retained runner evidence was captured.");
  return { status: "preserved", feature: manifest.feature, directory, commands: manifest.commands.length, evidenceDirectories: [...new Set(preserved)] };
}

if (action === "doctor") {
  const report = await doctor(target);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "ready") process.exitCode = 1;
} else if (action === "evidence") {
  console.log(JSON.stringify(await evidence(target), null, 2));
} else {
  const report = await doctor(target);
  if (report.status !== "ready") {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } else {
    const directory = await mkdtemp(join(tmpdir(), `broker-verification-${target}-`));
    const manifest = { feature: target, startedAt: new Date().toISOString(), doctor: report, status: "running", commands: [] };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Verification evidence: ${directory}`);
    try {
      for (const [index, script] of routes[target].scripts.entries()) {
        const command = await runScript(script, directory, index);
        manifest.commands.push(command);
        if (command.exitCode !== 0 || command.signal) throw new Error(`${script} failed; inspect ${join(directory, command.transcript)}`);
      }
      manifest.status = "passed";
    } catch (error) {
      manifest.status = "failed";
      manifest.error = error.message;
      process.exitCode = 1;
      manifest.failureDoctor = await doctor(target);
    } finally {
      manifest.finishedAt = new Date().toISOString();
      await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      console.log(`Verification ${manifest.status}; evidence: ${directory}`);
    }
    if (manifest.status === "passed") console.log(JSON.stringify(await evidence(directory), null, 2));
  }
}
