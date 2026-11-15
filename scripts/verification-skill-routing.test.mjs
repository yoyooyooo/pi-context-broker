import assert from "node:assert/strict"
import { readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (path) => readFileSync(resolve(root, path), "utf8")
const skills = [
  ".agents/skills/verify-context-broker/SKILL.md",
  ".agents/skills/verify-notion-consumer-state/SKILL.md",
  ".agents/skills/verify-notion-skills-integration/SKILL.md",
]
const routes = [
  "verify-notion-management",
  "verify-notion-consumption",
  "verify-notion-source-onboarding",
]

function verify(document, contents, scripts) {
  for (const route of routes) {
    assert.ok(document.includes(`.cursor/skills/${route}/SKILL.md`), `Missing CLI owner: ${route}`)
  }
  for (const [path, content] of contents) {
    assert.ok(content.includes("../../../docs/verification-routing.md"), `${path}: missing handoff`)
    const target = resolve(root, dirname(path), "../../../docs/verification-routing.md")
    assert.ok(statSync(target).isFile(), `${path}: invalid relative handoff`)
    assert.ok(document.includes(path), `${path}: missing reverse route`)
  }
  for (const boundary of ["disabled", "原ACK", "instruction_evaluation:not_run", "provider", "serializer"])
    assert.ok(document.includes(boundary), `Missing proof boundary: ${boundary}`)
  assert.ok(scripts["test:verification"].includes("scripts/verification-skill-routing.test.mjs"))
  assert.ok(scripts["check:broker"].includes("test:verification"))
  assert.ok(scripts.check.includes("test:verification"))
}

test("CLI owners and existing Broker guardians have bidirectional, gated handoff routes", () => {
  const document = read("docs/verification-routing.md")
  const contents = skills.map((path) => [path, read(path)])
  verify(document, contents, JSON.parse(read("package.json")).scripts)
})

test("lost owners, proof boundaries and CI routing cannot silently disappear", () => {
  const document = read("docs/verification-routing.md")
  const contents = skills.map((path) => [path, read(path)])
  const scripts = JSON.parse(read("package.json")).scripts
  for (const route of routes)
    assert.throws(() => verify(document.replaceAll(route, "removed-owner"), contents, scripts))
  assert.throws(() => verify(document.replaceAll("instruction_evaluation:not_run", "passed"), contents, scripts))
  assert.throws(() => verify(document, contents.map(([path, content]) => [path,
    content.replace("../../../docs/verification-routing.md", "missing-handoff.md")]), scripts))
  assert.throws(() => verify(document, contents, { ...scripts, "test:verification": "node --test unrelated.mjs" }))
})
