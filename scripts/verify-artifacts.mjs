import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { startRpc } from "../packages/context-broker/scripts/context-broker-rpc-harness.mjs";
import { writeFakeProvider, isolatedEnv, resolveHost, runCommand, assertSupportedPiVersion } from "../packages/context-broker/scripts/context-broker-e2e-fixture.mjs";
import { brokerRegistryVersion, verifyPackageClosure, verifyBundledRuntime } from "./verify-package-closure.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const usage = "Usage: node scripts/verify-artifacts.mjs [--host pi|omp] [--fixture ABSOLUTE_SDK_FIXTURE_JSON] [--require-sdk] [--name-fixture ABSOLUTE_NAME_FIXTURE_JSON] [--ambiguity-fixture ABSOLUTE_AMBIGUITY_FIXTURE_JSON] [--registry pi-context-broker@VERSION --expected-archive ABSOLUTE_TGZ] [--upgrade-from pi-context-broker@VERSION]";
const options = new Map();
for (let index = 0; index < args.length; index++) {
  const key = args[index];
  assert.ok(["--host", "--fixture", "--require-sdk", "--name-fixture", "--ambiguity-fixture", "--registry", "--expected-archive", "--upgrade-from"].includes(key) && !options.has(key), usage);
  if (key === "--require-sdk") options.set(key, true);
  else { const value = args[++index]; assert.ok(value && !value.startsWith("--"), usage); options.set(key, value); }
}
const host = options.get("--host") ?? "omp";
assert.ok(["pi", "omp"].includes(host), usage);
const sdkFixtureOption = options.get("--fixture"), requireSdk = options.has("--require-sdk");
const nameFixtureOption = options.get("--name-fixture");
const ambiguityFixtureOption = options.get("--ambiguity-fixture");
const registryPackage = options.get("--registry");
const expectedArchive = options.get("--expected-archive");
const upgradeFrom = options.get("--upgrade-from");
assert.ok(!registryPackage || host === "pi" && expectedArchive && isAbsolute(expectedArchive), "--registry requires --host pi and an absolute --expected-archive");
assert.ok(!expectedArchive || registryPackage, "--expected-archive requires --registry");
assert.ok(!upgradeFrom || host === "pi", "--upgrade-from requires --host pi");
if (registryPackage) brokerRegistryVersion(registryPackage);
if (upgradeFrom) brokerRegistryVersion(upgradeFrom);
assert.ok(!registryPackage || !process.env.CONTEXT_BROKER_CANDIDATE_DIR, "Registry verification cannot use a local candidate directory");
assert.ok(!sdkFixtureOption || host === "pi" && isAbsolute(sdkFixtureOption), "--fixture requires Pi and an absolute fixture path");
assert.ok(!requireSdk || host === "pi" && sdkFixtureOption, "--require-sdk requires --host pi and --fixture; SDK execution cannot be skipped");
assert.ok(!nameFixtureOption || host === "pi" && sdkFixtureOption && isAbsolute(nameFixtureOption), "--name-fixture requires --host pi, --fixture and an absolute name fixture path");
assert.ok(!ambiguityFixtureOption || host === "pi" && sdkFixtureOption && isAbsolute(ambiguityFixtureOption), "--ambiguity-fixture requires --host pi, --fixture and an absolute ambiguity fixture path");
const sdkFixture = sdkFixtureOption ? await realpath(sdkFixtureOption) : undefined;
if (sdkFixture) assert.ok((await stat(sdkFixture)).isFile(), "SDK fixture must be a file");
const nameFixture = nameFixtureOption ? await realpath(nameFixtureOption) : undefined;
if (nameFixture) assert.ok((await stat(nameFixture)).isFile(), "Name SDK fixture must be a file");
const ambiguityFixture = ambiguityFixtureOption ? await realpath(ambiguityFixtureOption) : undefined;
if (ambiguityFixture) assert.ok((await stat(ambiguityFixture)).isFile(), "Ambiguity SDK fixture must be a file");
const brokerOnly = host === "pi";
const base = await mkdtemp(join(tmpdir(), "broker-artifacts-"));
console.log(`Artifact workspace retained: ${base}`);
const report = { version: 1, host, status: "running", startedAt: new Date().toISOString(),
  notRun: brokerOnly ? ["OMP", "Tern", ...(sdkFixture ? [] : ["Default SDK installed Pi"]), ...(nameFixture ? [] : ["Named references installed Pi"]), ...(ambiguityFixture ? [] : ["Ambiguous references installed Pi"])] : ["Pi"],
  defaultSdk: { status: "not_run", required: requireSdk, reason: sdkFixture ? "artifact_gate_not_reached" : host === "pi" ? "fixture_not_provided" : "different_host" },
  namedSdk: { status: "not_run", required: Boolean(nameFixture), reason: nameFixture ? "artifact_gate_not_reached" : host === "pi" ? "name_fixture_not_provided" : "different_host", scenarios: [] },
  ambiguitySdk: { status: "not_run", required: Boolean(ambiguityFixture), reason: ambiguityFixture ? "artifact_gate_not_reached" : host === "pi" ? "ambiguity_fixture_not_provided" : "different_host" } };
const saveReport = () => writeFile(join(base, "manifest.json"), JSON.stringify(report, null, 2) + "\n");
await saveReport();
try {
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { cwd: base, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed: ${result.error?.message ?? result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result.stdout;
}
async function runtimePath(directory, entry) {
  assert.equal(typeof entry, "string");
  assert.ok(!isAbsolute(entry), `Absolute runtime entry: ${entry}`);
  const path = resolve(directory, entry);
  const local = relative(directory, path);
  assert.ok(local && local !== ".." && !local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), `Escaping runtime entry: ${entry}`);
  assert.ok((await stat(path)).isFile(), `Runtime entry is not a file: ${entry}`);
  return path;
}
const identity = async path => {
  const bytes = await readFile(path);
  return { path: await realpath(path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};
async function selectedBuildInput(entry) {
  assert.ok(isAbsolute(entry), "Explicit CLI build input must be absolute");
  let directory = dirname(entry);
  while (true) {
    const path = join(directory, "package.json");
    let metadata;
    try { metadata = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (metadata?.name === "ntn-skills") {
      const exported = metadata.exports?.["./sdk"];
      const sdk = typeof exported === "string" ? exported : exported?.import;
      assert.ok(typeof sdk === "string" && sdk.startsWith("./"), "Frozen CLI input must export its own Node SDK");
      return { mode: "explicit", package: metadata.name, version: metadata.version,
        manifest: await identity(path), cli: await identity(entry), sdk: await identity(await runtimePath(directory, sdk)) };
    }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, "Explicit build entry is not inside an ntn-skills package");
    directory = parent;
  }
}
async function verifyDocumentLinks(directory, entries) {
  const pending = [...entries];
  const visited = new Set();
  while (pending.length > 0) {
    const entry = pending.pop();
    const file = await runtimePath(directory, entry);
    if (!entry.endsWith(".md") || visited.has(file)) continue;
    visited.add(file);
    const document = await readFile(file, "utf8");
    for (const match of document.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const [target, fragment] = match[1].split("#");
      if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      const destination = target ? resolve(dirname(file), decodeURIComponent(target)) : file;
      const local = relative(directory, destination);
      await runtimePath(directory, local);
      if (fragment) {
        const contents = await readFile(destination, "utf8");
        const anchors = [...contents.matchAll(/^#{1,6}\s+(.+)$/gm)].map(heading => heading[1].toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-"));
        assert.ok(anchors.includes(decodeURIComponent(fragment)), `Missing documentation anchor: ${entry} -> ${match[1]}`);
      }
      pending.push(local);
    }
  }
}
const output = join(base, "archives");
const candidateDirectory = process.env.CONTEXT_BROKER_CANDIDATE_DIR;
const selectedEntry = process.env.NTN_SKILLS_BUILD_ENTRY;
const selectedInput = selectedEntry ? await selectedBuildInput(selectedEntry) : undefined;
if (selectedInput) { report.buildInput = selectedInput; await saveReport(); }
let brokerArchive, ternArchive;
if (registryPackage) brokerArchive = expectedArchive;
else {
  if (candidateDirectory) {
    assert.ok(isAbsolute(candidateDirectory), "Candidate directory must be absolute");
    await mkdir(output);
    const { copyFile } = await import("node:fs/promises");
    for (const name of await readdir(candidateDirectory))
      if (name.startsWith("pi-context-broker-") && name.endsWith(".tgz") || !brokerOnly && name === "tern-context-broker.tar.gz")
        await copyFile(join(candidateDirectory, name), join(output, name));
  } else run(process.execPath, [join(root, "scripts/pack.mjs"), "--out-dir", output, "--target", brokerOnly ? "broker" : "all"], { cwd: root, stdio: "inherit" });
  const archives = await readdir(output);
  const npmArchives = archives.filter(name => name.endsWith(".tgz"));
  assert.equal(npmArchives.length, 1);
  brokerArchive = join(output, npmArchives[0]);
  if (!brokerOnly) ternArchive = join(output, "tern-context-broker.tar.gz");
}
let ternExtract;
const closure = await verifyPackageClosure({ brokerArchive, ternArchive, registryPackage, upgradeFrom, base: join(base, "strict-closure") });
const installed = closure.installed;
report.installation = closure.installation;
if (closure.distribution) report.distribution = closure.distribution;
ternExtract = closure.tern;
const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
assert.ok(manifest.pi?.extensions?.length);
assert.ok(manifest.omp?.extensions?.length);
for (const entry of [...manifest.pi.extensions, ...manifest.omp.extensions, ...Object.values(manifest.bin)]) await runtimePath(installed, entry);
await verifyDocumentLinks(installed, ["README.md", "README.zh-CN.md", "docs/reference.md", "docs/reference.zh-CN.md", "CONTRIBUTING.md"]);
if (ternExtract) await verifyDocumentLinks(ternExtract, ["README.md", "README.zh-CN.md"]);
const npmQuery = await runtimePath(installed, manifest.bin["context-broker-complete"]);
const ternQuery = ternExtract ? await runtimePath(ternExtract, "query/completion.mjs") : undefined;
const queryExecutables = [npmQuery, ...(ternQuery ? [ternQuery] : [])];
await access(npmQuery, constants.X_OK);
if (ternQuery) await access(ternQuery, constants.X_OK);
report.package = { name: manifest.name, version: manifest.version, archive: await identity(closure.brokerArchive), installed };
report.runtime = { extension: await identity(resolve(installed, manifest[host].extensions[0])),
  cli: await identity(join(installed, "dist/ntn-skills.mjs")), sdk: await identity(join(installed, "dist/ntn-skills-sdk.mjs")),
  manifest: JSON.parse(await readFile(join(installed, "dist/ntn-skills-runtime.json"), "utf8")) };
if (selectedInput) assert.deepEqual(await selectedBuildInput(selectedEntry), selectedInput, "Frozen CLI/SDK input changed during packaging");
const expectedCliVersion = selectedInput?.version ?? (registryPackage ? report.runtime.manifest.package_version : manifest.devDependencies["ntn-skills"]);
report.buildInput ??= { mode: registryPackage ? "verified-registry-archive" : "declared-release", package: "ntn-skills", version: expectedCliVersion };
verifyBundledRuntime({ manifest: report.runtime.manifest, expectedVersion: expectedCliVersion,
  cliBytes: await readFile(report.runtime.cli.path), sdkBytes: await readFile(report.runtime.sdk.path) });
await saveReport();

const skillRoot = join(base, "skills");
await mkdir(join(skillRoot, "design-review"), { recursive: true });
const marker = "ARTIFACT_PRIVATE_SKILL_BODY_中文😀";
const localSkillPath = join(skillRoot, "design-review/SKILL.md");
await writeFile(localSkillPath, `---\nname: design-review\ndescription: Artifact review\nautoload:\n  enabled: true\n  aliases: [架构评审]\n---\n${marker}\n`);
const config = join(base, "config.yml");
await writeFile(config, `skillRoots:\n  - ${JSON.stringify(skillRoot)}\nsources: []\n`);
const enabledConfig = join(base, "notion-enabled-config.json");
await writeFile(enabledConfig, JSON.stringify({
  skillRoots: [skillRoot],
  sources: [{ id: "notion-setup", type: "notion", command: join(base, "missing-notion-cli") }],
}));
const agentDir = join(base, "agent");
await mkdir(agentDir);
const capture = join(base, "provider.jsonl");
const env = isolatedEnv({ base, agentDir, CONTEXT_BROKER_CONFIG: enabledConfig, CONTEXT_BROKER_ROOTS: skillRoot, CONTEXT_BROKER_HOST: host, CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: capture, NOTION_API_TOKEN: "",
  BROKER_E2E_PROCESS_LEDGER: join(base, "owned-processes.jsonl") });
const hostCommand = await resolveHost(host);
const hostVersion = (await runCommand(host, ["--version"], { cwd: base, env, timeoutMs: 10000 })).stdout.trim();
if (host === "pi") assertSupportedPiVersion(hostVersion);
report.hostIdentity = { ...hostCommand, version: hostVersion, executable: await identity(hostCommand.identity) };
await saveReport();
function localChoice(response) {
  const item = response.items.find(item => item.ref === localSkillPath && item.source === "local");
  assert.ok(item, "Packaged query must retain the exact configured local identity");
  assert.equal(item.kind, "skill");
  assert.equal(typeof item.identity, "string");
  assert.ok(item.identity.length > 0);
  const [name, identity, namespace, extra] = item.value.split("@");
  assert.equal(name, "$design-review");
  assert.equal(decodeURIComponent(identity), "local:" + localSkillPath);
  assert.equal(namespace, "local");
  assert.equal(extra, undefined);
  return item;
}
const localSelection = localChoice(JSON.parse(run(process.execPath, [npmQuery], {
  input: JSON.stringify({ version: 1, text: "$design", cursor: 7, cwd: base, config }), env,
})));
const builtinSelections = [];
const builtinIdentities = new Map();
for (const [label, executable, directory] of [
  ["npm", npmQuery, closure.builtins.npmRoot],
  ...(ternQuery ? [["tern", ternQuery, closure.builtins.ternRoot]] : []),
]) {
  const text = "$ntn-skills";
  const disabled = JSON.parse(run(process.execPath, [executable], {
    input: JSON.stringify({ version: 1, text, cursor: text.length, cwd: base, config }), env,
  }));
  assert.deepEqual(disabled.failures ?? [], [], `${label}: no Notion source must not attempt remote discovery`);
  assert.ok(!disabled.items.some(item => closure.builtins.names.some(name => item.value === "$" + name + "@builtin")),
    `${label}: do not advertise bundled Notion workflows before an enabled source is configured`);
  const response = JSON.parse(run(process.execPath, [executable], {
    input: JSON.stringify({ version: 1, text, cursor: text.length, cwd: base, config: enabledConfig }), env,
  }));
  assert.equal(response.failures?.[0]?.code, "SOURCE_COMMAND_UNAVAILABLE", `${label}: the Notion source is explicitly enabled but unavailable`);
  for (const name of closure.builtins.names) {
    const expectedPath = await runtimePath(directory, name + "/SKILL.md");
    const item = response.items.find(item => item.value === "$" + name + "@builtin");
    assert.ok(item, `${label}: missing exact bundled selection ${name}`);
    assert.equal(item.kind, "skill");
    assert.equal(item.source, "local");
    assert.equal(await realpath(item.ref), await realpath(expectedPath), `${label}: builtin selection escaped its own artifact`);
    assert.equal(typeof item.identity, "string");
    if (builtinIdentities.has(name)) assert.equal(item.identity, builtinIdentities.get(name));
    else builtinIdentities.set(name, item.identity);
    assert.equal("body" in item, false, "Completion must remain metadata-only");
    builtinSelections.push({ label, name, value: item.value, body: await readFile(expectedPath, "utf8") });
  }
}
const provider = await writeFakeProvider(base);
const sessionDir = join(base, "sessions");
await mkdir(sessionDir);
const rpc = await startRpc({ host, cwd: base, env, args: ["--no-extensions", "--no-skills", "--no-tools", ...(host === "omp" ? ["--no-rules", "--no-title"] : []), "--session-dir", sessionDir, "-e", provider, ...manifest[host].extensions.flatMap(entry => ["-e", resolve(installed, entry)]), "--model", "context-broker-e2e/fake", "--system-prompt", "Only output OK."] });
try {
  // Explicit $ invocations require a leading whitespace/punctuation boundary.
  await rpc.prompt(`中文😀请使用 ${localSelection.value}。`);
  await rpc.prompt(`再次使用 ${localSelection.value}。`);
  for (const item of builtinSelections)
    await rpc.prompt(`Inspect ${item.value} from the ${item.label} completion without executing its workflow.`);
} finally {
  await rpc.stop();
  await writeFile(join(base, "rpc.json"), JSON.stringify(rpc.frames, null, 2) + "\n");
  report.hostLifecycle = rpc.lifecycle;
  await saveReport();
}
const contexts = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line).context);
assert.equal(contexts.length, 2 + builtinSelections.length, "Expected one provider request per explicit package selection");
for (const [turn, context] of contexts.entries()) assert.equal(JSON.stringify(context).split(marker).length - 1, 1, `Provider turn ${turn + 1}: skill body must appear exactly once`);
for (const [index, item] of builtinSelections.entries()) {
  const body = item.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const retained = JSON.stringify(body).slice(1, -1);
  assert.equal(JSON.stringify(contexts[index + 2]).split(retained).length - 1, 1, `${item.label}/${item.name}: ordinary selection must load the complete packaged body exactly once`);
}
const builtinStatus = JSON.parse(run(process.execPath, [join(installed, "dist/ntn-skills.mjs"), "ctl", "builtin", "list"], { env }));
assert.ok(builtinStatus.skills.every(skill => skill.installation.state === "not_installed"), "Ordinary builtin selections must not install central Skills");

if (ternExtract) {
const ternManifest = await readFile(join(ternExtract, "plugin.toml"), "utf8");
assert.match(ternManifest, /^schema\s*=\s*1\s*$/m);
const windowEntry = ternManifest.match(/^window\s*=\s*"([^"]+)"\s*$/m)?.[1];
assert.ok(windowEntry, "Tern manifest must declare a window entry");
const visited = new Set();
async function luauClosure(entry) {
  const path = await runtimePath(ternExtract, entry);
  if (visited.has(path)) return;
  visited.add(path);
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/require\(\s*"(\.[^"]+)"\s*\)/g)) {
    const dependency = resolve(dirname(path), match[1].endsWith(".luau") ? match[1] : `${match[1]}.luau`);
    await luauClosure(relative(ternExtract, dependency));
  }
  for (const match of source.matchAll(/tern\.plugin\.dir\s*\.\.\s*"\/([^"]+)"/g)) await runtimePath(ternExtract, match[1]);
}
await luauClosure(windowEntry);
}
for (const directory of queryExecutables.map(dirname)) {
  const cli = await runtimePath(directory, "ntn-skills.mjs");
  await runtimePath(directory, "NOTICES.txt");
  assert.equal(run(process.execPath, [cli, "--version"], { env }).trim(), `ntn-skills v${expectedCliVersion}`, "Bundled CLI must match its frozen build input");
  const schema = JSON.parse(run(process.execPath, [cli, "schema", "read"], { env }));
  assert.equal(schema.ok, true);
  assert.equal(schema.format, "effect-cli-schema");
  assert.ok(schema.schema.parameters.some(parameter => parameter.name === "target" && parameter.type === "string"));
  for (const command of ["list", "use"]) {
    const publicSchema = JSON.parse(run(process.execPath, [cli, "schema", command], { env }));
    assert.equal(publicSchema.ok, true);
    assert.deepEqual(publicSchema.command, [command], "Installed consumer must expose the calibrated daily command surface");
  }
  const configured = JSON.parse(run(process.execPath, [cli, "ctl", "config", "set", "cache_policy.read_max_age_ms", "0"], { env }));
  assert.equal(configured.ok, true);
  const shown = JSON.parse(run(process.execPath, [cli, "ctl", "config", "show"], { env }));
  assert.equal(shown.config.cache_policy.read_max_age_ms, 0);
  const operationSchema = JSON.parse(run(process.execPath, [cli, "schema", "ctl", "operation", "list"], { env }));
  assert.deepEqual(operationSchema.command, ["ctl", "operation", "list"]);
  const operations = JSON.parse(run(process.execPath, [cli, "ctl", "operation", "list"], { env }));
  assert.equal(operations.ok, true);
  const backup = JSON.parse(run(process.execPath, [cli, "ctl", "backup", "--output", join(base, directory === dirname(npmQuery) ? "npm-state-backup" : "tern-state-backup")], { env }));
  assert.equal(backup.verified, true);
  assert.ok((await stat(join(env.NTN_SKILLS_HOME, "state.sqlite"))).size > 0);
}
if (ternQuery) assert.deepEqual(await readFile(join(dirname(npmQuery), "ntn-skills.mjs")), await readFile(join(dirname(ternQuery), "ntn-skills.mjs")), "Broker and Tern must ship identical current CLI consumer bytes");
const failingConfig = join(base, "missing-notion-config.json");
await writeFile(failingConfig, JSON.stringify({ skillRoots: [skillRoot], sources: [{ id: "notion", type: "notion" }] }));
for (const executable of queryExecutables) {
  const response = JSON.parse(run(process.execPath, [executable], {
    input: JSON.stringify({ version: 1, text: "$design", cursor: 7, cwd: base, config: failingConfig }),
    env: { ...env, NOTION_API_TOKEN: "" },
  }));
  const item = localChoice(response);
  assert.equal(item.identity, localSelection.identity);
  assert.equal(item.value, localSelection.value);
  assert.equal(response.failures[0].code, "AUTH_REQUIRED");
}
run(process.execPath, [join(root, "scripts/verify-source-dependencies.mjs"), "--host", host], { env: { ...process.env, BROKER_DEPENDENCY_EXTENSION: resolve(installed, manifest[host].extensions[0]) }, stdio: "inherit", timeout: 360_000 });
const text = "中文😀\n使用 $架构 tail";
const cursor = text.indexOf(" tail");
const request = JSON.stringify({ version: 1, text, cursor, cwd: base, config });
for (const executable of queryExecutables) {
  // Each invocation starts an independent Node process outside the checkout.
  const response = JSON.parse(run(process.execPath, [executable], { input: request, env }));
  assert.deepEqual(response.edit, { from: text.indexOf("$"), to: cursor, len: text.length, prefix: "$架构" });
  const item = localChoice(response);
  assert.equal(item.identity, localSelection.identity, "Chinese alias must select the same exact local record");
  assert.equal(item.value, localSelection.value);
  assert.equal(text.slice(0, response.edit.from) + item.value + text.slice(response.edit.to), `中文😀\n使用 ${localSelection.value} tail`);
  assert.ok(!JSON.stringify(response).includes(marker), "Query must not expose skill body");
  const bad = spawnSync(process.execPath, [executable], { cwd: base, env, encoding: "utf8", input: JSON.stringify({ version: 1, text: "😀", cursor: 1, cwd: base, config }), timeout: 20_000 });
  assert.equal(bad.status, 1, "Query must reject a split UTF-16 surrogate pair");
  assert.match(bad.stderr, /surrogate/i);
}
async function verifySdkScenario(fixture, scenario, entry, evidenceName) {
  delete entry.reason;
  const evidence = join(base, evidenceName + "-pi");
  const command = [join(root, "scripts/notion-sdk-pi.mjs"), "run", "--package", installed, "--fixture", fixture, "--scenario", scenario, "--out", evidence];
  Object.assign(entry, { status: "running", evidence, command: [process.execPath, ...command],
    fixture: await identity(fixture), driver: await identity(command[0]) });
  await saveReport();
  try {
    const execution = spawnSync(process.execPath, command, { cwd: root, env: process.env, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    await writeFile(join(base, evidenceName + "-stdout.log"), execution.stdout ?? "", { mode: 0o600 });
    await writeFile(join(base, evidenceName + "-stderr.log"), execution.stderr ?? "", { mode: 0o600 });
    entry.exit = { code: execution.status, signal: execution.signal, error: execution.error?.message ?? null };
    const observed = {};
    for (const [name, file] of [["plan", "plan.json"], ["result", "report.json"]]) {
      const path = join(evidence, file);
      try { observed[name] = JSON.parse(await readFile(path, "utf8")); entry[name] = await identity(path); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    assert.ok(!execution.error && execution.status === 0, "Installed SDK Pi driver failed; inspect retained " + evidenceName + " logs and scenario evidence");
    const { plan, result } = observed;
    assert.ok(plan && result, "Installed default SDK Pi driver must retain its plan and result");
    assert.equal(plan.package, await realpath(installed), "SDK scenarios must use this same independently installed package");
    assert.deepEqual(plan.runtime, report.runtime.manifest, "SDK scenarios must retain the same bundled CLI/SDK identity");
    assert.equal(plan.driver_sha256, entry.driver.sha256);
    assert.equal(plan.pi, report.hostIdentity.version); assert.equal(plan.source_command_configured, false);
    for (const field of ["expect_short_refs", "expect_compact_context", "expect_direct_scalar", "expect_short_confirmations"])
      assert.equal(plan[field], true, "Installed SDK assertions may not be disabled: " + field);
    if (scenario === "all") { assert.equal(plan.scenarios.length, 14); assert.equal(new Set(plan.scenarios).size, 14); }
    else assert.deepEqual(plan.scenarios, [scenario], "The named gate must execute its selected scenario");
    assert.equal(result.status, "passed"); assert.equal(result.package_unchanged, true); assert.equal(result.evidence_stable, true);
    assert.equal(result.evidence, await realpath(evidence));
    assert.deepEqual(result.results.map(row => row.name), plan.scenarios, "All planned SDK scenarios must complete");
    assert.ok(result.results.every(row => row.status === "passed" && row.observer_finality === true), "Every SDK scenario must pass with closed observers");
    assert.deepEqual(await identity(fixture), entry.fixture, "Original SDK fixture changed during verification");
    entry.status = "passed";
    entry.scenarios = result.results.map(({ name, status, observer_finality }) => ({ name, status, observer_finality }));
  } catch (error) { entry.status = "failed"; throw error; }
  finally { await saveReport(); }
}
if (sdkFixture) await verifySdkScenario(sdkFixture, "all", report.defaultSdk, "default-sdk");
if (nameFixture) {
  delete report.namedSdk.reason;
  report.namedSdk.status = "running";
  try {
    for (const name of ["name-references", "name-reference-failed-source"]) {
      const entry = { name, status: "running", required: true };
      report.namedSdk.scenarios.push(entry);
      await verifySdkScenario(nameFixture, name, entry, "sdk-" + name);
    }
    report.namedSdk.status = "passed";
  } catch (error) { report.namedSdk.status = "failed"; throw error; }
  finally { await saveReport(); }
}
if (ambiguityFixture) await verifySdkScenario(ambiguityFixture, "name-reference-ambiguity", report.ambiguitySdk, "sdk-name-reference-ambiguity");
report.status = "passed";
report.providerRequests = contexts.length;
report.assertions = ["independent-npm-install", "actual-host-rpc", "complete-local-and-builtin-bodies", "source-failure-isolation", "bundled-cli-sdk-identity", "offline-resources", "metadata-only-completion"];
if (registryPackage) report.assertions.push("registry-candidate-integrity-and-bytes");
if (upgradeFrom) report.assertions.push("existing-consumer-upgrade", "user-configuration-preserved", "no-stale-package-files");
if (report.defaultSdk.status === "passed") report.assertions.push("default-sdk-installed-pi-all14");
if (report.namedSdk.status === "passed") report.assertions.push("default-sdk-installed-pi-named-references");
if (report.ambiguitySdk.status === "passed") report.assertions.push("default-sdk-installed-pi-actionable-ambiguity");
console.log(`Artifact verification passed: ${host} actual installed RPC, complete builtin bodies, independent Node queries and offline resources${ternExtract ? ", Tern runtime closure" : ""}. Fixtures retained: ${base}`);
} catch (error) {
  report.status = "failed";
  report.error = { code: error.code ?? error.name, message: error.message };
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await saveReport();
}
