import assert from "node:assert/strict"
import test from "node:test"
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
