import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { assertFormalCase, assertFormalResult, inspectFormalResult } from "./formal-result-contract.mjs"

const c = {
  model: "Example",
  config: "cfg",
  expected_broken: [],
  expected_rules: ["TypeOK", "Safety", "Eventually", "NoDeadlock"],
}
const rule = (name, outcome = "holds", kind = "invariant") => ({ rule: { name, kind }, outcome })
const valid = () => ({
  exit: 0,
  states: { complete: true, cut: false },
  rules: [rule("TypeOK"), rule("Safety"), rule("NoDeadlock", "holds", "deadlock")],
  properties: [rule("Eventually", "holds", "property")],
})
const check = (sample, tc = c) => {
  assertFormalCase(tc)
  assertFormalResult(tc, sample, inspectFormalResult(tc, sample))
}
test("accepts complete positive and exact negative including temporal properties", () => {
  check(valid())
  const negative = valid()
  negative.exit = 1
  negative.properties[0].outcome = "broken"
  check(negative, { ...c, expected_broken: ["Eventually"] })
})
for (const [name, mutate] of [
  ["removed invariant", (v) => v.rules.splice(1, 1)],
  ["removed temporal property", (v) => v.properties.splice(0, 1)],
  ["duplicate rule replacing another", (v) => { v.rules[1] = rule("TypeOK") }],
  ["unexpected extra rule", (v) => v.rules.push(rule("Extra"))],
  ["unchecked outcome", (v) => { v.rules[1].outcome = "unchecked" }],
  ["parser/tool error", (v) => { v.exit = 2 }],
  ["timeout/termination", (v) => { v.exit = null }],
  ["cut exploration", (v) => { v.states.cut = true }],
  ["unfinished exploration", (v) => { v.states.complete = false }],
  ["wrong broken rule", (v) => { v.rules[1].outcome = "broken"; v.exit = 1 }],
]) {
  test("rejects " + name, () => {
    const sample = valid()
    mutate(sample)
    assert.throws(() => check(sample))
  })
}
test("a negative that unexpectedly turns green is rejected", () => {
  assert.throws(() => check(valid(), { ...c, expected_broken: ["Safety"] }))
})
test("empty or duplicate declared inventory is rejected", () => {
  assert.throws(() => assertFormalCase({ ...c, expected_rules: [] }))
  assert.throws(() => assertFormalCase({ ...c, expected_rules: ["Safety", "Safety"] }))
})

const evidenceControl = path.resolve(import.meta.dirname, "../.agents/skills/verify-notion-consumer-state/scripts/control.mjs")
const digest = bytes => createHash("sha256").update(bytes).digest("hex")
function evidenceFixture() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-state-evidence-contract-"))
  const names = ["contracts", "observations", "models", "regressions", "observation-mutations", "mutations"]
  const summaries = ["observations", "models", "observation-mutations", "mutations"]
  const manifest = { version: 2, complete: true, steps: [], summaryProofs: [] }
  for (const name of names) {
    const step = { name, exitCode: 0, signal: null }
    for (const stream of ["stdout", "stderr"]) {
      const bytes = Buffer.from(name + ": controlled transcript\n")
      step[stream] = name + "." + stream
      step[stream + "Sha256"] = digest(bytes)
      fs.writeFileSync(path.join(out, step[stream]), bytes)
    }
    manifest.steps.push(step)
  }
  for (const name of summaries) {
    fs.mkdirSync(path.join(out, name))
    const bytes = Buffer.from(JSON.stringify({ complete: true, fixture: "artifact integrity only, no model execution" }) + "\n")
    fs.writeFileSync(path.join(out, name, "summary.json"), bytes)
    manifest.summaryProofs.push({ name, sha256: digest(bytes) })
  }
  const save = () => fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest) + "\n")
  save()
  return { out, manifest, save }
}
function readEvidence(out) {
  const result = spawnSync(process.execPath, [evidenceControl, "evidence", "--out", out], { encoding: "utf8", timeout: 10000 })
  assert.equal(result.signal, null)
  assert.equal(result.error, undefined)
  return result
}
test("evidence preserves current complete transcripts and summaries", () => {
  const f = evidenceFixture()
  const result = readEvidence(f.out)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).status, "preserved")
})
for (const name of ["observations", "models", "observation-mutations", "mutations"]) {
  test("evidence rejects changed " + name + " summary even when complete remains true", () => {
    const f = evidenceFixture()
    fs.writeFileSync(path.join(f.out, name, "summary.json"), JSON.stringify({ complete: true, changed: true }) + "\n")
    const result = readEvidence(f.out)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Evidence summary changed/)
  })
}
test("evidence rejects missing summaries and incomplete execution inventory", () => {
  const missing = evidenceFixture()
  fs.renameSync(path.join(missing.out, "models", "summary.json"), path.join(missing.out, "models", "saved-summary.json"))
  assert.equal(readEvidence(missing.out).status, 1)
  const incomplete = evidenceFixture()
  incomplete.manifest.steps.splice(0, 1); incomplete.save()
  const result = readEvidence(incomplete.out)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Evidence step inventory changed/)
})
test("evidence cannot upgrade a failed step or a historical manifest", () => {
  const failed = evidenceFixture()
  failed.manifest.steps[0].exitCode = 1; failed.save()
  assert.match(readEvidence(failed.out).stderr, /Evidence contains a failed step/)
  const old = evidenceFixture()
  old.manifest.version = 1; old.save()
  const result = readEvidence(old.out)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /version 2 manifest/)
})
