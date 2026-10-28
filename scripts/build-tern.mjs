import { build } from "bun";
import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const broker = join(root, "packages/context-broker");
const tern = join(root, "packages/tern-context-broker");
const require = createRequire(join(broker, "package.json"));
const ntnEntry = process.env.NTN_SKILLS_BUILD_ENTRY
  ? resolve(process.env.NTN_SKILLS_BUILD_ENTRY)
  : require.resolve("ntn-skills/dist/ntn-skills.js");
async function findPackage(name, entry) {
  let directory = dirname(entry);
  while (true) {
    try {
      const manifest = join(directory, "package.json");
      const metadata = JSON.parse(await readFile(manifest, "utf8"));
      if (metadata.name === name) return { directory, manifest, metadata };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate ${name} package for ${entry}`);
    directory = parent;
  }
}
const selectedCli = await findPackage("ntn-skills", ntnEntry);
const selectedRequire = createRequire(selectedCli.manifest);
const brokerMetadata = JSON.parse(await readFile(join(broker, "package.json"), "utf8"));
const runtimeNames = ["effect", "@effect/platform-node", "@effect/sql-sqlite-node"];
const runtimeDependencies = {};
for (const name of runtimeNames) {
  const version = selectedCli.metadata.dependencies?.[name];
  if (version !== "4.0.5" || brokerMetadata.dependencies?.[name] !== version) {
    throw new Error(`Selected ntn-skills and Broker must declare ${name} exactly 4.0.5 (selected: ${version ?? "missing"}, Broker: ${brokerMetadata.dependencies?.[name] ?? "missing"})`);
  }
  const installed = JSON.parse(await readFile(selectedRequire.resolve(`${name}/package.json`), "utf8"));
  const brokerInstalled = JSON.parse(await readFile(require.resolve(`${name}/package.json`), "utf8"));
  if (installed.version !== version || brokerInstalled.version !== version) {
    throw new Error(`Installed ${name} must match selected ntn-skills ${version} (selected: ${installed.version}, Broker: ${brokerInstalled.version}); install dependencies in both checkouts before building`);
  }
  runtimeDependencies[name] = version;
}
const sharedRuntime = "@effect/platform-node-shared";
if (brokerMetadata.dependencies?.[sharedRuntime] !== "4.0.5") throw new Error(`Broker must declare ${sharedRuntime} exactly 4.0.5 for npm consumers`);
runtimeDependencies[sharedRuntime] = "4.0.5";
for (const resolver of [selectedRequire, require]) {
  const platformRequire = createRequire(resolver.resolve("@effect/platform-node/package.json"));
  const installed = JSON.parse(await readFile(platformRequire.resolve(`${sharedRuntime}/package.json`), "utf8"));
  if (installed.version !== "4.0.5") {
    throw new Error(`Selected CLI and Broker require ${sharedRuntime} exactly 4.0.5 (installed: ${installed.version})`);
  }
}
const builtinSkills = [
  ["ntn-skills", "skills/ntn-skills"],
  ["ntn-skills-maintain", "skills/notion/ntn-skills-maintain"],
  ["ntn-skills-sync", "skills/notion/ntn-skills-sync"],
];
for (const [, source] of builtinSkills) {
  await readFile(join(selectedCli.directory, source, "SKILL.md"), "utf8");
}
const cliResult = await build({
  entrypoints: [ntnEntry], target: "node", format: "esm", packages: "bundle", minify: true,
  external: runtimeNames.flatMap(name => [name, `${name}/*`]),
});
if (!cliResult.success || !cliResult.outputs[0]) throw new AggregateError(cliResult.logs, "Notion CLI build failed");
const cliCode = await cliResult.outputs[0].text();
const licenseFiles = new Map();
async function collectLicenses(name, from) {
  if (licenseFiles.has(name)) return;
  let directory = name === "ntn-skills"
    ? dirname(ntnEntry)
    : dirname(createRequire(from).resolve(`${name}/package.json`));
  let metadata;
  while (true) {
    try {
      metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (metadata.name === name) break;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate license for ${name}`);
    directory = parent;
  }
  const license = (await readdir(directory)).find(file => /^licen[sc]e(?:\.md|\.txt)?$/i.test(file));
  if (!license) throw new Error(`Missing license for ${name}`);
  licenseFiles.set(name, await readFile(join(directory, license), "utf8"));
  for (const dependency of Object.keys(metadata.dependencies ?? {})) await collectLicenses(dependency, join(directory, "package.json"));
}
await collectLicenses("ntn-skills", join(broker, "package.json"));
const query = join(tern, "query");
await mkdir(query, { recursive: true });
await writeFile(join(query, "package.json"), `${JSON.stringify({
  name: "tern-context-broker-query-runtime", private: true, type: "module",
  dependencies: runtimeDependencies,
}, null, 2)}\n`);
// npm reconciles the generated production tree and prunes extraneous packages.
const install = spawnSync("npm", ["install", "--prefix", query, "--workspaces=false", "--install-strategy=hoisted", "--package-lock=true", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: root, stdio: "inherit",
});
if (install.status !== 0) throw new Error(`Tern production runtime install failed (${install.status ?? install.error?.message ?? "no exit status"})`);
const queryRequire = createRequire(join(query, "package.json"));
for (const name of runtimeNames) {
  const installed = JSON.parse(await readFile(queryRequire.resolve(`${name}/package.json`), "utf8"));
  if (installed.version !== runtimeDependencies[name]) throw new Error(`Tern ${name} ${installed.version} differs from selected CLI ${runtimeDependencies[name]}`);
}
const queryPlatformRequire = createRequire(queryRequire.resolve("@effect/platform-node/package.json"));
const queryShared = JSON.parse(await readFile(queryPlatformRequire.resolve(`${sharedRuntime}/package.json`), "utf8"));
if (queryShared.version !== "4.0.5") throw new Error(`Tern ${sharedRuntime} must be 4.0.5 (installed: ${queryShared.version})`);
for (const directory of [join(broker, "dist"), join(tern, "query")]) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "ntn-skills.mjs"), cliCode);
  await writeFile(join(directory, "NOTICES.txt"), [...licenseFiles].map(([name, license]) => `Bundled dependency: ${name}\n${license.trim()}\n`).join("\n"));
  const builtinRoot = join(directory, "builtin-skills");
  await rm(builtinRoot, { recursive: true, force: true });
  await mkdir(builtinRoot, { recursive: true });
  for (const [name, source] of builtinSkills) {
    await cp(join(selectedCli.directory, source), join(builtinRoot, name), { recursive: true });
  }
}
const result = await build({
  entrypoints: [join(broker, "src/completion-cli.ts")],
  target: "node",
  format: "esm",
  packages: "bundle",
  external: ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-coding-agent/modes/components"],
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "Completion query build failed");
const output = result.outputs[0];
if (!output) throw new Error("Completion query build emitted no program");
const yamlLicense = await readFile(join(dirname(createRequire(join(broker, "package.json")).resolve("yaml/package.json")), "LICENSE"), "utf8");
const program = await output.text();
const prefixEnd = program.startsWith("#!") ? program.indexOf("\n") + 1 : 0;
const code = `${program.slice(0, prefixEnd)}/*\nBundled dependency: yaml (ISC)\n${yamlLicense.trim()}\n*/\n${program.slice(prefixEnd)}`;
for (const path of [join(broker, "dist/completion.mjs"), join(tern, "query/completion.mjs")]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, code);
  await chmod(path, 0o755);
}
for (const name of ["README.md", "README.zh-CN.md", "CONTRIBUTING.md", "LICENSE", "SECURITY.md", "CHANGELOG.md"]) {
  const contents = await readFile(join(root, name), "utf8");
  const projected = contents
    .replaceAll("./packages/context-broker/examples/", "./examples/")
    .replaceAll("./packages/context-broker/docs/", "./docs/")
    .replaceAll("./packages/tern-context-broker/README.md", "https://github.com/yoyooyooo/pi-context-broker/blob/main/packages/tern-context-broker/README.md")
    .replaceAll("./packages/tern-context-broker/README.zh-CN.md", "https://github.com/yoyooyooo/pi-context-broker/blob/main/packages/tern-context-broker/README.zh-CN.md")
    .replaceAll("(./.agents/", "(https://github.com/yoyooyooo/pi-context-broker/blob/main/.agents/")
    .replaceAll("(.agents/skills/verify-context-broker/SKILL.md)", "(https://github.com/yoyooyooo/pi-context-broker/tree/main/.agents/skills/verify-context-broker/SKILL.md)");
  await writeFile(join(broker, name), projected);
}
await copyFile(join(root, "LICENSE"), join(tern, "LICENSE"));
const manifest = await readFile(join(tern, "plugin.toml"), "utf8");
const metadata = JSON.parse(await readFile(join(tern, "package.json"), "utf8"));
if (!manifest.includes(`version = "${metadata.version}"`)) throw new Error("Tern package and manifest versions differ");
console.log("Built standalone broker query and Tern plugin query");
