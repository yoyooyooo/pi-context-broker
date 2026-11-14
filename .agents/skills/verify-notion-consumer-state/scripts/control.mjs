#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const repository = path.resolve(import.meta.dirname, "../../../..");
const args = process.argv.slice(2);
const command = args[0], option = args[1], output = args[2];
if (!command || ["--help", "help"].includes(command)) {
  console.log("Usage: node .agents/skills/verify-notion-consumer-state/scripts/control.mjs doctor | run --out /absolute/new-or-empty/output | evidence --out /absolute/output");
  process.exit(0);
}
assert.ok(["doctor", "run", "evidence"].includes(command), "Unknown command");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const hashFile = file => hash(fs.readFileSync(file));
const lockPath = path.join(repository, "verification/models/consumer-observations/tool-lock.json");
function doctor() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  assert.ok(major === 24 && minor >= 20 || major === 22 && (minor > 22 || minor === 22 && patch >= 3),
    "Use supported Node 22.22.3+ or 24.20.0+");
  const tool = process.env.PSTACK_STATECHART_ROOT, jar = process.env.TLA2TOOLS;
  assert.ok(tool && path.isAbsolute(tool) && jar && path.isAbsolute(jar), "Set absolute PSTACK_STATECHART_ROOT and TLA2TOOLS from the existing frozen tool installation");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(hashFile(jar), lock.tlc_sha256, "Frozen TLC hash mismatch");
  for (const entry of lock.files) assert.equal(hashFile(path.join(tool, entry.path)), entry.sha256, "Frozen statechart changed: " + entry.path);
  const bun = spawnSync("bun", ["--version"], { cwd: repository, encoding: "utf8" });
  const java = spawnSync("java", ["-version"], { cwd: repository, encoding: "utf8" });
  assert.equal(bun.status, 0, "Bun is required"); assert.equal(java.status, 0, "Java is required");
  assert.ok(fs.existsSync(path.join(repository, "packages/context-broker/node_modules")), "Run the repository's frozen-lockfile dependency installation first");
  return { status: "ready", node: process.version, bun: bun.stdout.trim(), java: (java.stderr || java.stdout).trim(),
    statechartCommit: lock.commit, statechartFiles: lock.files.length, tlcSha256: lock.tlc_sha256,
    toolRoot: tool, jar, authorization: "Controlled local code/model checks only; no Notion, host model, credential or install proof" };
}
if (command === "doctor") {
  assert.equal(args.length, 1);
  console.log(JSON.stringify(doctor(), null, 2)); process.exit(0);
}
assert.equal(option, "--out"); assert.equal(args.length, 3); assert.ok(path.isAbsolute(output), "Use an absolute output path");
const out = path.resolve(output), manifestFile = path.join(out, "manifest.json");
if (command === "evidence") {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(manifest.complete, true, "Run did not finish");
  for (const step of manifest.steps) for (const stream of ["stdout", "stderr"]) {
    assert.equal(hashFile(path.join(out, step[stream])), step[stream + "Sha256"], "Evidence transcript changed");
  }
  for (const name of ["legacy-models", "models", "legacy-mutations", "mutations"]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, name, "summary.json"), "utf8")).complete, true, name + " incomplete");
  }
  console.log(JSON.stringify({ status: "preserved", complete: true, manifest: manifestFile, manifestSha256: hashFile(manifestFile) }, null, 2));
  process.exit(0);
}
assert.ok(path.relative(repository, out).startsWith(".." + path.sep), "Keep evidence outside the repository");
if (fs.existsSync(out)) assert.equal(fs.readdirSync(out).length, 0, "Use a new or pre-created empty output directory");
else fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const state = { version: 1, skill: "verify-notion-consumer-state", checkout: repository, startedAt: new Date().toISOString(), steps: [], complete: false };
const save = () => fs.writeFileSync(manifestFile, JSON.stringify(state, null, 2) + "\n");
save();
try {
  state.doctor = doctor();
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  assert.equal(git.status, 0); state.checkoutCommit = git.stdout.trim();
  const inputs = new Set([
    ".agents/skills/verify-notion-consumer-state/SKILL.md", ".agents/skills/verify-notion-consumer-state/references/contracts.md",
    ".agents/skills/verify-notion-consumer-state/scripts/control.mjs", "scripts/verify-consumer-observations.mjs",
    "scripts/formal-result-contract.mjs", "scripts/check-consumer-observation-mutations.mjs",
    "scripts/check-consumer-state-mutations.mjs", "verification/models/consumer-observations/tool-lock.json",
  ]);
  for (const directory of ["consumer-observations", "consumer-state"]) {
    const coveragePath = "verification/models/" + directory + "/coverage.json";
    inputs.add(coveragePath);
    const coverage = JSON.parse(fs.readFileSync(path.join(repository, coveragePath), "utf8"));
    for (const source of Object.keys(coverage.files)) inputs.add(source);
    for (const entry of coverage.cases) for (const suffix of [".tla", "." + entry.config + ".cfg", ".view.mjs"])
      inputs.add("verification/models/" + directory + "/" + entry.model + suffix);
  }
  state.inputHashes = Object.fromEntries([...inputs].sort().map(file => [file, hashFile(path.join(repository, file))]));
  save();
  const tasks = [
    ["legacy-models", process.execPath, ["scripts/verify-consumer-observations.mjs", "--suite", "observations", "--out", path.join(out, "legacy-models")]],
    ["models", process.execPath, ["scripts/verify-consumer-observations.mjs", "--suite", "consumer-state", "--out", path.join(out, "models")]],
    ["regressions", "bun", ["test", ...["consumer-observation", "consumer-state", "host-prepare", "session-active", "native-read-session", "skill-context-session"].map(name => "packages/context-broker/scripts/" + name + ".test.ts"), "--timeout", "30000"]],
    ["legacy-mutations", process.execPath, ["scripts/check-consumer-observation-mutations.mjs", "--out", path.join(out, "legacy-mutations")]],
    ["mutations", process.execPath, ["scripts/check-consumer-state-mutations.mjs", "--out", path.join(out, "mutations")]],
  ];
  for (const [name, executable, argv] of tasks) {
    const step = { name, executable, argv, startedAt: new Date().toISOString(), stdout: name + ".stdout", stderr: name + ".stderr" };
    state.steps.push(step); save(); console.log("Starting " + name);
    const result = spawnSync(executable, argv, { cwd: repository, encoding: "utf8", timeout: 900000, maxBuffer: 32 * 1024 * 1024 });
    fs.writeFileSync(path.join(out, step.stdout), result.stdout ?? "");
    fs.writeFileSync(path.join(out, step.stderr), result.stderr ?? "");
    Object.assign(step, { exitCode: result.status, signal: result.signal, endedAt: new Date().toISOString(),
      stdoutSha256: hash(result.stdout ?? ""), stderrSha256: hash(result.stderr ?? "") }); save();
    assert.ok(!result.error && !result.signal && result.status === 0, name + " failed; inspect retained transcripts");
    console.log("Completed " + name);
  }
  for (const [file, expected] of Object.entries(state.inputHashes))
    assert.equal(hashFile(path.join(repository, file)), expected, "Input changed during verification: " + file);
  state.complete = true;
} catch (error) {
  state.error = { name: error.name, message: error.message };
  throw error;
} finally { state.endedAt = new Date().toISOString(); save(); }
console.log("Consumer-state evidence: " + out);
