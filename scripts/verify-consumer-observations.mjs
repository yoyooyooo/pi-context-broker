#!/usr/bin/env node
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { inspect } from "node:util"
import { assertFormalCase, assertFormalResult, inspectFormalResult } from "./formal-result-contract.mjs"

const repository = path.resolve(import.meta.dirname, "..")
const suites = {"observations":"verification/models/consumer-observations","flows":"verification/models/consumer-observations/flows","consumer-state":"verification/models/consumer-state"}
const defaultSuite = "observations"
const lockFile = "verification/models/consumer-observations/tool-lock.json"
const configExtension = ".cfg"
const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log("Usage: node scripts/verify-consumer-observations.mjs --out /absolute/new/output [--suite " +
    Object.keys(suites).join("|") + "] [--model Model] [--statechart PINNED_SKILL] [--jar TLC_JAR]")
  process.exit(0)
}
const options = new Map()
for (let i = 0; i < args.length; i += 2) {
  assert.ok(["--out", "--suite", "--model", "--statechart", "--jar"].includes(args[i]), "Unknown argument: " + args[i])
  assert.ok(args[i + 1] && !args[i + 1].startsWith("--"), "Missing argument value: " + args[i])
  assert.ok(!options.has(args[i]), "Repeated argument: " + args[i])
  options.set(args[i], args[i + 1])
}
if (options.has("--out")) assert.ok(path.isAbsolute(options.get("--out")), "--out must be absolute")
assert.ok(options.has("--out"), "Pass --out /absolute/new/output")
const suite = options.get("--suite") ?? defaultSuite
assert.ok(Object.hasOwn(suites, suite), "Unknown verification suite: " + suite)
const selectedModel = options.get("--model")
const root = path.join(repository, suites[suite])
const out = options.has("--out") ? path.resolve(options.get("--out")) :
  fs.mkdtempSync(path.join(os.tmpdir(), "notion-formal-"))
if (fs.existsSync(out)) assert.equal(fs.readdirSync(out).length, 0, "Use a new empty output directory")
else fs.mkdirSync(out, { recursive: true, mode: 0o700 })
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const head = spawnSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" })
assert.equal(head.status, 0)
const summary = {
  version: 2,
  suite,
  selected_model: selectedModel ?? null,
  checkout_commit: head.stdout.trim(),
  runner_sha256: hash(fs.readFileSync(import.meta.filename)),
  result_contract_sha256: hash(fs.readFileSync(new URL("./formal-result-contract.mjs", import.meta.url))),
  runs: [],
  complete: false,
}
const writeSummary = () => fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
writeSummary()
const originalRm = fs.rmSync
try {
  const coverageFile = path.join(root, "coverage.json")
  const coverage = JSON.parse(fs.readFileSync(coverageFile, "utf8"))
  const lock = JSON.parse(fs.readFileSync(path.join(repository, lockFile), "utf8"))
  const tool = options.get("--statechart") ?? process.env.PSTACK_STATECHART_ROOT
  const jar = options.get("--jar") ?? process.env.TLA2TOOLS
  assert.ok(tool && path.isAbsolute(tool) && jar && path.isAbsolute(jar),
    "Configure absolute PSTACK_STATECHART_ROOT and TLA2TOOLS; see the existing model README")
  summary.coverage_sha256 = hash(fs.readFileSync(coverageFile))
  summary.source_commit = coverage.synchronized_commit ?? coverage.source_base
  summary.source_hashes = coverage.files
  summary.maintenance = coverage.maintenance
  summary.pstack_commit = lock.commit
  summary.tlc = "1.7.4"
  summary.tlc_sha256 = hash(fs.readFileSync(jar))
  summary.tool_lock_sha256 = hash(fs.readFileSync(path.join(repository, lockFile)))
  summary.proofScope = coverage.kind ?? coverage.correspondence
  for (const [file, expected] of Object.entries(coverage.files)) {
    assert.equal(hash(fs.readFileSync(path.join(repository, file))), expected,
      "Model/source correspondence needs review before verification: " + file)
  }
  summary.source_hashes_verified = Object.keys(coverage.files)
  assert.equal(summary.tlc_sha256, lock.tlc_sha256, "Use the frozen TLC jar")
  for (const member of lock.files) {
    assert.equal(hash(fs.readFileSync(path.join(tool, member.path))), member.sha256,
      "Pinned statechart file changed: " + member.path)
  }
  summary.tool_files_verified = lock.files.length
  assert.ok(Array.isArray(coverage.cases) && coverage.cases.length > 0, "Missing reviewed case inventory")
  const identities = new Set()
  for (const c of coverage.cases) {
    assertFormalCase(c)
    const identity = c.model + "." + c.config
    assert.ok(!identities.has(identity), "Duplicate configured case: " + identity)
    identities.add(identity)
  }
  assert.ok(selectedModel === undefined || coverage.cases.some((c) => c.model === selectedModel), "Unknown model in suite")
  const cases = coverage.cases.filter((c) => selectedModel === undefined || c.model === selectedModel)
  summary.expected_cases = cases
  const scratch = path.join(out, "scratch")
  const retained = path.join(out, "retained-tool-temporaries")
  const inputs = path.join(out, "model-inputs")
  for (const p of [scratch, retained]) fs.mkdirSync(p, { mode: 0o700 })
  fs.cpSync(root, inputs, { recursive: true })
  process.env.TMPDIR = scratch
  process.env.TLA2TOOLS = path.resolve(jar)
  // Preserve all tool scratch, including failed runs, under this run's evidence.
  fs.rmSync = (name) => {
    const absolute = path.resolve(String(name))
    assert.equal(path.dirname(absolute), scratch, "Refuse cleanup outside this owned run")
    assert.ok(path.basename(absolute).startsWith("statechart-"))
    fs.renameSync(absolute, path.join(retained, path.basename(absolute)))
  }
  const { check } = await import(pathToFileURL(path.join(tool, "scripts/run.ts")))
  const { compile } = await import(pathToFileURL(path.join(tool, "scripts/pipeline.ts")))
  const { checkView } = await import(pathToFileURL(path.join(tool, "scripts/frontends/view.ts")))
  writeSummary()
  for (const c of cases) {
    const destination = path.join(out, c.model + "-" + c.config.replaceAll(".", "-"))
    fs.mkdirSync(destination)
    const spec = path.join(inputs, c.model + ".tla")
    const config = path.join(inputs, c.model + "." + c.config + configExtension)
    const viewFile = path.join(inputs, c.model + ".view.mjs")
    const inputHashes = [spec, config, viewFile].map((file) => ({
      path: path.relative(out, file), sha256: hash(fs.readFileSync(file)),
    }))
    const result = await check(spec, config)
    const view = checkView(await import(pathToFileURL(viewFile)), inspect)
    const rendered = compile(result, view)
    for (const [file, parts] of rendered.files) {
      const fd = fs.openSync(path.join(destination, file), "wx")
      try {
        for (const part of parts) fs.writeSync(fd, typeof part === "string" ? Buffer.from(part) : part)
        fs.writeSync(fd, "\n")
      } finally { fs.closeSync(fd) }
    }
    const observation = inspectFormalResult(c, result)
    const row = {
      model: c.model, config: c.config, variant: c.config,
      states: result.states, exit: result.exit, ...observation,
      expected_broken: c.expected_broken,
      inputs: inputHashes,
      report: path.relative(out, path.join(destination, "report.md")),
    }
    summary.runs.push(row)
    writeSummary()
    console.log(JSON.stringify({ model: c.model, config: c.config, states: result.states.distinct,
      broken: observation.broken, inventory_matches: observation.inventory_matches, matches: observation.matches }))
    assertFormalResult(c, result, observation)
  }
  summary.complete = true
} catch (error) {
  summary.error = { name: error.name, message: error.message }
  throw error
} finally {
  fs.rmSync = originalRm
  writeSummary()
}
console.log("Formal results and statecharts retained: " + out)
