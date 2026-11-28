import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { checkAgentContractCoverage } from "./notion-agent-scenarios.mjs"
import { parseArgs as parseSdkPiArgs } from "./notion-sdk-pi.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (path) => readFileSync(resolve(root, path), "utf8")
const skills = [
  ".agents/skills/verify-context-broker/SKILL.md",
  ".agents/skills/verify-notion-consumer-state/SKILL.md",
  ".agents/skills/verify-notion-skills-integration/SKILL.md",
  ".agents/skills/verify-notion-agent-workflows/SKILL.md",
]
const routes = [
  "verify-notion-management",
  "verify-notion-consumption",
  "verify-notion-source-onboarding",
]
const cacheFeature = ".agents/skills/verify-notion-skills-integration/features/session-cache-recovery.md"
const dailyFeature = ".agents/skills/verify-notion-skills-integration/features/daily-installation-ui.md"
const cacheScenarios = ["http-warm-restart", "http-warm-directory-expired", "http-smart-revalidate", "http-smart-current"]
const materializationFeature = ".agents/skills/verify-notion-skills-integration/features/source-materialization.md"
const materializationScenarios = ["source-materialize-legacy", "source-materialize-first", "source-materialize-legacy-source", "source-materialize-growth", "source-materialize-native-root", "source-materialize-cancel-late", "source-materialize-cold-budget", "source-materialize-cache-upgrade", "source-materialize-blocked-member"]

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
  documents.push(".agents/skills/verify-notion-agent-workflows/references/running.md")
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

function verifyCacheCommands(document, requiredScenarios = cacheScenarios) {
  const commands = [...document.replace(/\\\r?\n[ \t]*/gu, " ")
    .matchAll(/^node scripts\/notion-sdk-pi\.mjs (.+)$/gmu)]
    .map(match => parseSdkPiArgs(match[1].trim().split(/\s+/u)))
  const outputs = new Set()
  for (const scenario of requiredScenarios) {
    const matching = commands.filter(command => command.action === "run" && command["--scenario"] === scenario)
    assert.equal(matching.length, 1, "missing actual Pi execution: " + scenario)
    const command = matching[0]
    assert.ok(command["--pi"], "cache verification must select the actual installed Pi entry")
    assert.ok(!outputs.has(command["--out"]), "each scenario needs its own new evidence directory")
    outputs.add(command["--out"])
    assert.ok(commands.some(item => item.action === "evidence" && item["--evidence"] === command["--out"]),
      "cache execution must retain the existing evidence validation route: " + scenario)
  }
}

test("cache verification instructions execute all current public Pi scenarios and recheck their evidence", () => {
  const guide = read(cacheFeature)
  verifyCacheCommands(guide)
  for (const scenario of cacheScenarios)
    assert.throws(() => verifyCacheCommands(guide.replace("--scenario " + scenario, "--scenario default-view")),
      /missing actual Pi execution/u)
  assert.throws(() => verifyCacheCommands(guide.replace("notion-sdk-pi.mjs run", "notion-sdk-pi.mjs doctor")))
  assert.throws(() => verifyCacheCommands(guide.replace(/^node scripts\/notion-sdk-pi\.mjs evidence .*\n/gmu, "")),
    /evidence validation route/u)
  for (const path of [skills[0], skills[1], skills[2], "docs/verification-routing.md"]) {
    const content = read(path)
    assert.ok(content.includes("features/session-cache-recovery.md#新进程复用"), path + ": missing cache handoff")
    for (const scenario of cacheScenarios) assert.ok(content.includes(scenario), path + ": missing " + scenario)
  }
  const daily = read(dailyFeature)
  assert.match(daily, /^node scripts\/verify-pi-daily-installation\.mjs cache-plan --config \/absolute\/\S+$/mu)
  assert.match(daily, /^node scripts\/verify-pi-daily-installation\.mjs cache-run --config \/absolute\/\S+ --live$/mu)
})

test("Source materialization instructions require all initial states and actual Pi evidence replay", () => {
  const guide = read(materializationFeature)
  verifyCacheCommands(guide, materializationScenarios)
  for (const scenario of materializationScenarios)
    assert.throws(() => verifyCacheCommands(guide.replace("--scenario " + scenario, "--scenario default-view"), materializationScenarios), /missing actual Pi execution/u)
  assert.throws(() => verifyCacheCommands(guide.replace("notion-sdk-pi.mjs run", "notion-sdk-pi.mjs doctor"), materializationScenarios))
  for (const path of [skills[2], "docs/verification-routing.md"]) {
    const content = read(path)
    assert.ok(content.includes("features/source-materialization.md"), path + ": missing materialization handoff")
    for (const scenario of materializationScenarios) assert.ok(content.includes(scenario), path + ": missing " + scenario)
  }
})

function verifyMaterializationCi(workflow) {
  assert.match(workflow, /sdk-fixture\.ts --outdir "\$RUNNER_TEMP\/ntn-skills-current-fixture" --catalog --materialization/u,
    "CI must generate the selected CLI's real materialization originals")
  const paths = { BROKER_PACKAGE: "/absolute/ci/installed-broker", PI_ENTRY: "/absolute/ci/pi.mjs",
    RUNNER_TEMP: "/absolute/ci/tmp", GITHUB_WORKSPACE: "/absolute/ci/workspace" }
  const commands = workflow.split(/\r?\n/u).map(line => line.trim())
    .filter(line => line.startsWith("node scripts/notion-sdk-pi.mjs "))
    .map(line => line.replace(/"\$([A-Z_]+)([^"]*)"/gu, (_match, name, suffix) => {
      assert.ok(paths[name], "CI must select a declared installed input: " + name)
      return paths[name] + suffix
    })).join("\n")
  verifyCacheCommands(commands, materializationScenarios)
  for (const scenario of materializationScenarios)
    assert.ok(workflow.includes("${{ runner.temp }}/pi-" + scenario + "/"), "CI must retain raw evidence: " + scenario)
  assert.match(workflow, /name: Preserve current SDK results\s+if: always\(\)/u,
    "Failed runs must retain their original evidence")
}

test("CI runs every materialization initial state and independently replays retained Pi evidence", () => {
  const workflow = read(".github/workflows/ci.yml")
  verifyMaterializationCi(workflow)
  for (const scenario of materializationScenarios) {
    assert.throws(() => verifyMaterializationCi(workflow.replace("--scenario " + scenario + "\n", "--scenario default-view\n")), /missing actual Pi execution/u)
    assert.throws(() => verifyMaterializationCi(workflow.replace('node scripts/notion-sdk-pi.mjs evidence --evidence "$RUNNER_TEMP/pi-' + scenario + '"', "# removed replay")), /evidence validation route/u)
    assert.throws(() => verifyMaterializationCi(workflow.replace("${{ runner.temp }}/pi-" + scenario + "/", "removed-output")), /retain raw evidence/u)
  }
  assert.throws(() => verifyMaterializationCi(workflow.replace("--catalog --materialization", "--catalog")), /real materialization originals/u)
})

test("the public daily entry exposes real read-only help with its actions and required flags", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-pi-daily-installation.mjs", "--help"], {
    cwd: root, encoding: "utf8", timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.trim(), "help must not silently import an implementation module")
  for (const token of ["candidate-plan", "candidate-run", "cache-plan", "cache-run", "--config", "--live"])
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
        if (entry.command.startsWith("node scripts/notion-sdk-pi.mjs "))
          parseSdkPiArgs(entry.command.slice("node scripts/notion-sdk-pi.mjs ".length).trim().split(/\s+/u))
        for (const match of entry.command.matchAll(/(?<![\w./-])((?:packages|scripts|verification)\/[\w./-]+\.(?:ts|mjs|py))\b/gu))
          assert.ok(statSync(resolve(root, match[1])).isFile(), row.id + ": missing Broker command")
      }
    }
  }
  check(map)
  const corpus = JSON.parse(read("scripts/notion-agent-scenarios.json"))
  checkAgentContractCoverage(corpus, map)
  const staleLibraryJourney = structuredClone(corpus)
  const libraryJourney = staleLibraryJourney.scenarios.find(scenario => scenario.id === "library-b-management-consumption")
  libraryJourney.contract_ids = libraryJourney.contract_ids.map(id => id === "T24" ? "T22" : id)
  assert.throws(() => checkAgentContractCoverage(staleLibraryJourney, map), /T22 maps none/u)
  assert.throws(() => check({ ...map, external_domains: map.external_domains.slice(1) }))
  const changed = structuredClone(map)
  changed.contracts[0].entrypoints.push({ repository: "broker", command: "node scripts/nonexistent-current-contract.mjs" })
  assert.throws(() => check(changed))
  const imported = structuredClone(map)
  imported.contracts[0].entrypoints.push({ repository: "broker", command: "node scripts/verify-pi-daily-candidate.mjs --help", required_inputs: [] })
  assert.throws(() => check(imported), /not a public CLI/u)
})

test("natural workflow ownership has one executable route and keeps the subject free of private instructions", () => {
  const skill = read(".agents/skills/verify-notion-agent-workflows/SKILL.md")
  const guide = read(".agents/skills/verify-notion-agent-workflows/references/running.md")
  const map = read("docs/verification-routing.md")
  for (const token of ["magpie/group/worker", "no-native-skills", "candidate-plan", "candidate-run", "notion-agent-workflow", "holdout-", "instruction_evaluation:not_run"])
    assert.ok(skill.includes(token), "missing workflow boundary: " + token)
  for (const token of ["prepareAgentFixtures", "checkAgentContractCoverage", "bindingsFile", "cleanupAgentFixtures", "subjectExited", "external"])
    assert.ok(guide.includes(token), "missing executable preparation/cleanup step: " + token)
  assert.ok(skill.includes("被测 Pi 只收到自然 prompt"))
  assert.ok(skill.includes("外部扫尾"))
  assert.ok(map.includes("agent-workflows 拥有 C08"))
  assert.ok(!map.includes("context-broker 拥有 C08"))
})
