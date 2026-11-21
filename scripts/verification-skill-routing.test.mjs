import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
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

function currentDocuments() {
  const documents = [...skills, "docs/verification-routing.md", "CONTRIBUTING.md"]
  for (const skill of ["verify-context-broker", "verify-notion-skills-integration"]) {
    const directory = `.agents/skills/${skill}/features`
    for (const file of readdirSync(resolve(root, directory)))
      if (file.endsWith(".md")) documents.push(`${directory}/${file}`)
  }
  return documents.map(path => [path, read(path)])
}

function verifyCurrentRoutes(documents) {
  for (const [path, content] of documents) {
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const target = match[1].split("#")[0]
      if (!target || /^[a-z]+:/iu.test(target)) continue
      assert.ok(statSync(resolve(root, dirname(path), target)).isFile(), `${path}: missing link ${target}`)
    }
    for (const match of content.matchAll(/(?<![\w./-])((?:packages\/context-broker\/|\.agents\/skills\/[\w-]+\/)?scripts\/[\w./-]+\.(?:mjs|ts|py))\b/gu))
      assert.ok(statSync(resolve(root, match[1])).isFile(), `${path}: missing executable route ${match[1]}`)
  }
}

test("current verification maps resolve their links and existing executable routes", () => {
  const documents = currentDocuments()
  verifyCurrentRoutes(documents)
  assert.throws(() => verifyCurrentRoutes([[skills[0], "[missing](missing-route.md)"]]))
  assert.throws(() => verifyCurrentRoutes([[skills[0], "node scripts/missing-current-route.mjs"]]))
})

test("the public daily entry exposes real read-only help with its actions and required flags", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-pi-daily-installation.mjs", "--help"], {
    cwd: root, encoding: "utf8", timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.trim(), "help must not silently import an implementation module")
  for (const token of ["candidate-plan", "candidate-run", "--config", "--live"])
    assert.ok(result.stdout.includes(token), "missing public help: " + token)
})

test("paired CLI contract owners and Broker commands resolve in this actual checkout", {
  skip: process.env.CONTEXT_BROKER_GRAPH_CORE ? false : "Set CONTEXT_BROKER_GRAPH_CORE to the paired CLI source; cross-repository routing not run.",
}, () => {
  const cliRoot = resolve(process.env.CONTEXT_BROKER_GRAPH_CORE, "../../..")
  const map = JSON.parse(readFileSync(resolve(cliRoot, "verification/skill-domains.json"), "utf8"))
  const check = (value) => {
    assert.equal(value.version, 2, "paired CLI must expose the current contract index")
    assert.deepEqual(value.external_domains.map(domain => domain.skill).sort(), [...skills].sort())
    for (const domain of value.external_domains)
      assert.ok(statSync(resolve(root, domain.skill)).isFile(), "missing external owner")
    for (const row of [...value.contracts, ...value.scenarios]) {
      for (const entry of row.entrypoints) {
        if (entry.repository !== "broker") continue
        assert.doesNotMatch(entry.command, /^node scripts\/verify-pi-daily-candidate\.mjs(?:\s|$)/u,
          "the candidate implementation module is not a public CLI")
        if (entry.command.includes("/absolute/")) assert.ok(entry.required_inputs?.length,
          "an absolute config placeholder requires explicit inputs and is not an executed result")
        for (const match of entry.command.matchAll(/\b((?:packages|scripts|verification)\/[\w./-]+\.(?:ts|mjs|py))\b/gu))
          assert.ok(statSync(resolve(root, match[1])).isFile(), row.id + ": missing Broker command")
      }
    }
  }
  check(map)
  assert.throws(() => check({ ...map, external_domains: map.external_domains.slice(1) }))
  const changed = structuredClone(map)
  changed.contracts[0].entrypoints.push({ repository: "broker", command: "node scripts/nonexistent-current-contract.mjs" })
  assert.throws(() => check(changed))
  const imported = structuredClone(map)
  imported.contracts[0].entrypoints.push({ repository: "broker", command: "node scripts/verify-pi-daily-candidate.mjs --help", required_inputs: [] })
  assert.throws(() => check(imported), /not a public CLI/u)
})
