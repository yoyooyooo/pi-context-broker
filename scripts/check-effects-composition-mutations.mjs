#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const cases = [
  {
    "name": "prior-source-effects",
    "file": "src/host-skills.ts",
    "old": "if (!observedEffects.length) throw error;\n      const effects = combineConsumptionEffects([...observedEffects, errorConsumptionEffects(error)]);",
    "replacement": "if (!observedEffects.length) throw error;\n      const effects = combineConsumptionEffects([errorConsumptionEffects(error)]);",
    "test": "host-prepare.test.ts",
    "pattern": "dollar preflight failure keeps earlier source effects",
    "properties": [
      "ConfirmedFactsPreserved",
      "NoFalseZeroWriteReport"
    ]
  },
  {
    "name": "unknown-summary",
    "file": "src/consumption-effects.ts",
    "old": "receipts.some(value => value.remote_writes === \"unknown\") ? \"unknown\"",
    "replacement": "false ? \"unknown\"",
    "test": "formal-effects-composition.test.ts",
    "pattern": "two acquisitions preserve",
    "properties": [
      "UnknownEffectIsSticky"
    ]
  },
  {
    "name": "retention-facts",
    "file": "src/consumption-effects.ts",
    "old": "retention: [...retention.values()]",
    "replacement": "retention: []",
    "test": "formal-effects-composition.test.ts",
    "pattern": "two acquisitions preserve",
    "properties": [
      "ConfirmedFactsPreserved"
    ]
  },
  {
    "name": "retention-identity",
    "file": "src/consumption-effects.ts",
    "old": "JSON.stringify([entry.skill_page_id, entry.file_id, entry.operation_id])",
    "replacement": "JSON.stringify([entry.file_id, entry.operation_id])",
    "test": "formal-effects-composition.test.ts",
    "pattern": "retention identity includes",
    "properties": [
      "ConfirmedFactsPreserved"
    ]
  },
  {
    "name": "unknown-fact-status",
    "file": "src/consumption-effects.ts",
    "old": "entry.status === \"unknown\" || previous?.status === \"unknown\" ? \"unknown\" : \"confirmed\"",
    "replacement": "entry.status === \"unknown\" ? \"unknown\" : \"confirmed\"",
    "test": "formal-effects-composition.test.ts",
    "pattern": "retention identity includes",
    "properties": [
      "UnknownEffectIsSticky"
    ]
  },
  {
    "name": "legacy-sdk-capability",
    "file": "src/notion-sdk.ts",
    "old": "if (options.readOnly && (sdk.CONSUMPTION_EFFECTS_VERSION !== 1 || consumptionEffectsVersion !== 1))",
    "replacement": "if (false)",
    "test": "notion-sdk.test.ts",
    "pattern": "strict read-only requires matching",
    "properties": [
      "CompatibleSdkBeforeDispatch"
    ]
  },
  {
    "name": "cancelled-prepared-effects",
    "file": "src/host-skills.ts",
    "old": "    try {\n      checkPreparationSignal(executionSignal);\n      const result = await read(prepared?.input ?? input, executionSignal);",
    "replacement": "    checkPreparationSignal(executionSignal);\n    try {\n      const result = await read(prepared?.input ?? input, executionSignal);",
    "test": "host-prepare.test.ts",
    "pattern": "native cancellation after preparation",
    "properties": [
      "ConfirmedFactsPreserved",
      "NoFalseZeroWriteReport"
    ]
  }
];
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/check-effects-composition-mutations.mjs --out /absolute/new/output [--case NAME]");
  process.exit(0);
}
assert.equal(args[0], "--out");
assert.ok(args.length === 2 || args.length === 4 && args[2] === "--case");
assert.ok(path.isAbsolute(args[1]), "Output must be an absolute new directory");
const selected = args.length === 4 ? cases.filter(item => item.name === args[3]) : cases;
assert.ok(selected.length, "Unknown mutation case");
const repository = path.resolve(import.meta.dirname, ".."), pkg = path.join(repository, "packages/context-broker"), out = args[1];
fs.mkdirSync(out, { recursive: false, mode: 0o700 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, "Bun is required");
const summary = { version: 1, bun: version.stdout.trim(), sourceCheckout: repository, cases: [], complete: false };
const save = () => fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
save();
try {

const coverage = JSON.parse(fs.readFileSync(path.join(repository, "verification/models/consumer-observations/flows/coverage.json"), "utf8"));
for (const item of selected) {
  for (const relative of [item.file, "scripts/" + item.test]) {
    const covered = "packages/context-broker/" + relative;
    assert.equal(hash(fs.readFileSync(path.join(pkg, relative))), coverage.files[covered],
      "Source correspondence needs review: " + covered);
  }
}

  for (const item of selected) {
    const directory = path.join(out, item.name);
    fs.mkdirSync(directory);
    for (const name of ["src", "scripts"]) fs.cpSync(path.join(pkg, name), path.join(directory, name), { recursive: true, errorOnExist: true, force: false });
    fs.copyFileSync(path.join(pkg, "package.json"), path.join(directory, "package.json"));
    fs.symlinkSync(path.join(pkg, "node_modules"), path.join(directory, "node_modules"), "dir");
    const originalFile = path.join(pkg, item.file), file = path.join(directory, item.file);
    const original = fs.readFileSync(file, "utf8"), originalHash = hash(Buffer.from(original));
    assert.equal(original.split(item.old).length, 2, item.name + ": guard changed; review the mutation");
    const entry = { name: item.name, properties: item.properties, source: path.relative(repository, originalFile),
      sourceSha256: originalHash, test: item.test, pattern: item.pattern,
      testSha256: hash(fs.readFileSync(path.join(pkg, "scripts", item.test))), phases: [], restored: false, originalWorkspaceUnchanged: false };
    summary.cases.push(entry); save();
    const run = phase => {
      const argv = ["test", path.join(directory, "scripts", item.test), "--test-name-pattern", item.pattern, "--timeout", "30000"];
      const started = Date.now(), result = spawnSync("bun", argv, { cwd: directory, encoding: "utf8", timeout: 60000 });
      fs.writeFileSync(path.join(directory, phase + ".stdout"), result.stdout ?? "");
      fs.writeFileSync(path.join(directory, phase + ".stderr"), result.stderr ?? "");
      entry.phases.push({ phase, argv, exitCode: result.status, signal: result.signal, elapsedMs: Date.now() - started,
        stdoutSha256: hash(result.stdout ?? ""), stderrSha256: hash(result.stderr ?? "") }); save();
      assert.ok(!result.error && !result.signal, item.name + ": execution error is not a guard counterexample");
      return result;
    };
    const baseline = run("baseline");
    assert.equal(baseline.status, 0, item.name + ": baseline");
    assert.match(baseline.stderr, /[1-9][0-9]* pass/, item.name + ": no matched baseline test");
    fs.writeFileSync(file, original.replace(item.old, item.replacement));
    const mutated = run("mutated");
    assert.equal(mutated.status, 1, item.name + ": mutation must fail");
    assert.match(mutated.stderr, /error: expect|Expected:|expect\(received\)/, item.name + ": must fail a behavior assertion");
    assert.doesNotMatch(mutated.stderr, /SyntaxError|Cannot find module|Module not found|error: Cannot find/);
    fs.writeFileSync(file, original);
    const restored = run("restored");
    assert.equal(restored.status, 0, item.name + ": restored replay");
    assert.equal(hash(fs.readFileSync(file)), originalHash);
    assert.equal(hash(fs.readFileSync(originalFile)), originalHash, "Active checkout changed during isolated mutation");
    entry.restored = true; entry.originalWorkspaceUnchanged = true; save();
    console.log(JSON.stringify({ name: item.name, baseline: 0, mutated: 1, restored: 0, originalWorkspaceUnchanged: true }));
  }
  summary.complete = true;
} catch (error) {
  summary.error = { name: error.name, message: error.message };
  throw error;
} finally { save(); }
console.log("Real-guard mutation evidence: " + out);

