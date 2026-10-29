import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { startRpc } from "../packages/context-broker/scripts/context-broker-rpc-harness.mjs";
import { writeFakeProvider, isolatedEnv } from "../packages/context-broker/scripts/context-broker-e2e-fixture.mjs";
import { verifyPackageClosure } from "./verify-package-closure.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--host" || args[1] !== "omp")) throw new Error("Usage: node scripts/verify-artifacts.mjs [--host omp]");
const host = args[1] ?? "omp";
const base = await mkdtemp(join(tmpdir(), "broker-artifacts-"));
console.log(`Artifact workspace retained: ${base}`);
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
if (candidateDirectory) {
  assert.ok(isAbsolute(candidateDirectory), "Candidate directory must be absolute");
  await mkdir(output);
  const { copyFile } = await import("node:fs/promises");
  for (const name of await readdir(candidateDirectory))
    if (name.startsWith("pi-context-broker-") && name.endsWith(".tgz") || name === "tern-context-broker.tar.gz")
      await copyFile(join(candidateDirectory, name), join(output, name));
} else run(process.execPath, [join(root, "scripts/pack.mjs"), "--out-dir", output], { cwd: root, stdio: "inherit" });
const archives = await readdir(output);
const npmArchives = archives.filter(name => name.endsWith(".tgz"));
assert.equal(npmArchives.length, 1);
let ternExtract;
const closure = await verifyPackageClosure({ brokerArchive: join(output, npmArchives[0]), ternArchive: join(output, "tern-context-broker.tar.gz"), base: join(base, "strict-closure") });
const installed = closure.installed;
ternExtract = closure.tern;
const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
assert.ok(manifest.pi?.extensions?.length);
assert.ok(manifest.omp?.extensions?.length);
for (const entry of [...manifest.pi.extensions, ...manifest.omp.extensions, ...Object.values(manifest.bin)]) await runtimePath(installed, entry);
await verifyDocumentLinks(installed, ["README.md", "README.zh-CN.md", "docs/reference.md", "docs/reference.zh-CN.md", "CONTRIBUTING.md"]);
await verifyDocumentLinks(ternExtract, ["README.md", "README.zh-CN.md"]);
const npmQuery = await runtimePath(installed, manifest.bin["context-broker-complete"]);
const ternQuery = await runtimePath(ternExtract, "query/completion.mjs");
await access(npmQuery, constants.X_OK);
await access(ternQuery, constants.X_OK);

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
const env = isolatedEnv({ base, agentDir, CONTEXT_BROKER_CONFIG: enabledConfig, CONTEXT_BROKER_ROOTS: skillRoot, CONTEXT_BROKER_HOST: "omp", CONTEXT_BROKER_E2E_PROVIDER_CONTEXT_FILE: capture, NTN_SKILLS_NTN_BIN: join(base, "absent-ntn") });
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
  ["tern", ternQuery, closure.builtins.ternRoot],
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
const rpc = await startRpc({ host, cwd: base, env, args: ["--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-title", "--session-dir", sessionDir, "-e", provider, ...manifest.omp.extensions.flatMap(entry => ["-e", resolve(installed, entry)]), "--model", "context-broker-e2e/fake", "--system-prompt", "Only output OK."] });
try {
  // Explicit $ invocations require a leading whitespace/punctuation boundary.
  await rpc.prompt(`中文😀请使用 ${localSelection.value}。`);
  await rpc.prompt(`再次使用 ${localSelection.value}。`);
  for (const item of builtinSelections)
    await rpc.prompt(`Inspect ${item.value} from the ${item.label} completion without executing its workflow.`);
} finally {
  await rpc.stop();
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
for (const directory of [dirname(npmQuery), dirname(ternQuery)]) {
  const cli = await runtimePath(directory, "ntn-skills.mjs");
  await runtimePath(directory, "NOTICES.txt");
  assert.equal(run(process.execPath, [cli, "--version"], { env }).trim(), `ntn-skills v${manifest.devDependencies["ntn-skills"]}`, "Bundled CLI must match the declared release dependency");
  const schema = JSON.parse(run(process.execPath, [cli, "schema", "read"], { env }));
  assert.equal(schema.ok, true);
  assert.equal(schema.format, "effect-cli-schema");
  assert.ok(schema.schema.parameters.some(parameter => parameter.name === "target" && parameter.type === "string"));
  const configured = JSON.parse(run(process.execPath, [cli, "ctl", "config", "set", "cache_policy.read_max_age_ms", "0"], { env }));
  assert.equal(configured.ok, true);
  const shown = JSON.parse(run(process.execPath, [cli, "ctl", "config", "show"], { env }));
  assert.equal(shown.config.cache_policy.read_max_age_ms, 0);
  const operations = JSON.parse(run(process.execPath, [cli, "operation", "list"], { env }));
  assert.equal(operations.ok, true);
  const backup = JSON.parse(run(process.execPath, [cli, "ctl", "backup", "--output", join(base, directory === dirname(npmQuery) ? "npm-state-backup" : "tern-state-backup")], { env }));
  assert.equal(backup.verified, true);
  assert.ok((await stat(join(env.NTN_SKILLS_HOME, "state.sqlite"))).size > 0);
}
assert.deepEqual(await readFile(join(dirname(npmQuery), "ntn-skills.mjs")), await readFile(join(dirname(ternQuery), "ntn-skills.mjs")), "Broker and Tern must ship identical current CLI consumer bytes");
const failingConfig = join(base, "missing-notion-config.json");
await writeFile(failingConfig, JSON.stringify({ skillRoots: [skillRoot], sources: [{ id: "notion", type: "notion" }] }));
for (const executable of [npmQuery, ternQuery]) {
  const response = JSON.parse(run(process.execPath, [executable], {
    input: JSON.stringify({ version: 1, text: "$design", cursor: 7, cwd: base, config: failingConfig }),
    env: { ...env, NTN_SKILLS_NTN_BIN: join(base, "absent-ntn") },
  }));
  const item = localChoice(response);
  assert.equal(item.identity, localSelection.identity);
  assert.equal(item.value, localSelection.value);
  assert.equal(response.failures[0].code, "NTN_UNAVAILABLE");
}
run(process.execPath, [join(root, "scripts/verify-source-dependencies.mjs")], { env: { ...process.env, BROKER_DEPENDENCY_EXTENSION: resolve(installed, manifest.omp.extensions[0]) }, stdio: "inherit", timeout: 360_000 });
const text = "中文😀\n使用 $架构 tail";
const cursor = text.indexOf(" tail");
const request = JSON.stringify({ version: 1, text, cursor, cwd: base, config });
for (const executable of [npmQuery, ternQuery]) {
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
console.log(`Artifact verification passed: bilingual documentation navigation, npm production install, unpacked OMP exact selections and complete builtin bodies, npm and Tern independent Node queries and offline builtin/reference reads, Tern runtime closure. Fixtures retained: ${base}`);
