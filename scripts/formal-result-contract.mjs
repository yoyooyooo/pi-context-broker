import assert from "node:assert/strict"

// Independent expected_rules are reviewed coverage data, never derived from
// the config being checked. A removed declaration must fail this contract.
export function inspectFormalResult(testCase, result) {
  const rules = [...result.rules, ...(result.properties ?? [])].map(({ rule, outcome }) => ({
    name: rule.name,
    kind: rule.kind,
    outcome,
  }))
  const names = rules.map((rule) => rule.name).sort()
  const expectedRules = [...testCase.expected_rules].sort()
  const broken = rules.filter((rule) => rule.outcome === "broken").map((rule) => rule.name).sort()
  const expected = [...testCase.expected_broken].sort()
  return {
    rules,
    broken,
    expected,
    expected_rules: expectedRules,
    inventory_matches: JSON.stringify(names) === JSON.stringify(expectedRules),
    matches:
      names.length > 0 &&
      new Set(names).size === names.length &&
      JSON.stringify(names) === JSON.stringify(expectedRules) &&
      JSON.stringify(broken) === JSON.stringify(expected) &&
      rules.every((rule) => rule.outcome === "holds" || rule.outcome === "broken"),
  }
}

export function assertFormalCase(testCase) {
  assert.match(testCase.model, /^[A-Za-z][A-Za-z0-9_]*$/)
  assert.match(testCase.config, /^[A-Za-z0-9][A-Za-z0-9.-]*$/)
  for (const key of ["expected_broken", "expected_rules"]) {
    assert.ok(Array.isArray(testCase[key]), "Missing " + key)
    assert.equal(new Set(testCase[key]).size, testCase[key].length, "Duplicate " + key)
    assert.ok(testCase[key].every((name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name)), key)
  }
  assert.ok(testCase.expected_rules.length > 0, "Empty rule inventory")
  assert.ok(testCase.expected_broken.every((name) => testCase.expected_rules.includes(name)))
}

export function assertFormalResult(testCase, result, observation) {
  const id = testCase.model + "/" + testCase.config
  assert.ok(result.exit === 0 || result.exit === 1, "Tool/model error: " + id)
  assert.ok(result.states.complete && !result.states.cut, "Incomplete exploration: " + id)
  assert.ok(observation.inventory_matches, "Changed or missing rule inventory: " + id)
  assert.ok(observation.matches, "Unexpected or unchecked property: " + id)
}
