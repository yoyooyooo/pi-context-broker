import { build } from "bun";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2), options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1];
  if (!["--target", "--package-out"].includes(key) || !value || options.has(key)) throw new Error("Usage: bun scripts/build-tern.mjs [--target all|broker] [--package-out /new/absolute/directory]");
  options.set(key, value);
}
const target = options.get("--target") ?? "all";
if (!["all", "broker"].includes(target)) throw new Error("--target must be all or broker");
const buildTern = target !== "broker";
const broker = join(root, "packages/context-broker");
const requestedOutput = options.get("--package-out");
if (requestedOutput !== undefined && (buildTern || !isAbsolute(requestedOutput))) throw new Error("--package-out requires --target broker and a new absolute directory");
const brokerOutput = requestedOutput === undefined ? broker : resolve(requestedOutput);
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
const sdkExport = selectedCli.metadata.exports?.["./sdk"];
const sdkImport = typeof sdkExport === "string" ? sdkExport : sdkExport?.import;
if (typeof sdkImport !== "string" || !sdkImport.startsWith("./")) throw new Error("The selected ntn-skills package must include the Node ESM ntn-skills/sdk export; select a complete compatible package with NTN_SKILLS_BUILD_ENTRY");
const sdkEntry = resolve(selectedCli.directory, sdkImport);
const selectedSdkApi = await import(pathToFileURL(sdkEntry).href);
const resourceReadVersion = selectedSdkApi.RESOURCE_READ_CONTRACT_VERSION;
if (resourceReadVersion !== undefined && (resourceReadVersion !== 1 || typeof selectedSdkApi.readResources !== "function" || typeof selectedSdkApi.decodeResourceReadResult !== "function")) {
  throw new Error("The selected ntn-skills SDK resource-read capability is incompatible");
}
const readOutputProofVersion = selectedSdkApi.READ_OUTPUT_PROOF_VERSION;
if (readOutputProofVersion !== undefined && (readOutputProofVersion !== 1 || typeof selectedSdkApi.readSkill !== "function")) {
  throw new Error("The selected ntn-skills SDK read output proof is incompatible");
}
const catalogDirectoryVersion = selectedSdkApi.CATALOG_DIRECTORY_CONTRACT_VERSION;
const consumptionEffectsVersion = selectedSdkApi.CONSUMPTION_EFFECTS_VERSION;
if (consumptionEffectsVersion !== undefined && consumptionEffectsVersion !== 1) throw new Error("Unsupported consumption effects contract");
const resourceEffectsVersion = selectedSdkApi.RESOURCE_READ_EFFECTS_VERSION;
if (resourceEffectsVersion !== undefined && (resourceEffectsVersion !== 1 || resourceReadVersion !== 1 || consumptionEffectsVersion !== 1)) {
  throw new Error("The selected ntn-skills SDK resource-read effects capability is incompatible");
}
if (catalogDirectoryVersion !== undefined && (catalogDirectoryVersion !== 1 || typeof selectedSdkApi.listCatalog !== "function")) {
  throw new Error("The selected ntn-skills SDK catalog directory capability is incompatible");
}
const selectedSdk = await findPackage("ntn-skills", sdkEntry);
if (await realpath(selectedSdk.directory) !== await realpath(selectedCli.directory)) throw new Error("CLI and SDK must come from the same selected ntn-skills package");
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
const sdkResult = await build({
  entrypoints: [sdkEntry], target: "node", format: "esm", packages: "bundle", minify: true,
  external: runtimeNames.flatMap(name => [name, `${name}/*`]),
});
if (!sdkResult.success || !sdkResult.outputs[0]) throw new AggregateError(sdkResult.logs, "Notion SDK build failed");
const sdkCode = await sdkResult.outputs[0].text();
const runtimeManifest = { version: 1, package: "ntn-skills", package_version: selectedCli.metadata.version,
  sdk_version: 1, consumer_contract_version: 1, ...(resourceReadVersion === undefined ? {} : { resource_read_contract_version: resourceReadVersion }),
  ...(readOutputProofVersion === undefined ? {} : { read_output_proof_version: readOutputProofVersion }),
  ...(catalogDirectoryVersion === undefined ? {} : { catalog_directory_contract_version: catalogDirectoryVersion }),
  ...(consumptionEffectsVersion === undefined ? {} : { consumption_effects_version: consumptionEffectsVersion }),
  ...(resourceEffectsVersion === undefined ? {} : { resource_read_effects_version: resourceEffectsVersion }),
  cli_sha256: createHash("sha256").update(cliCode).digest("hex"), sdk_sha256: createHash("sha256").update(sdkCode).digest("hex") };
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
if (brokerOutput !== broker) {
  await mkdir(dirname(brokerOutput), { recursive: true });
  // A separate package build never overwrites a prior artifact or checkout output.
  await mkdir(brokerOutput);
  for (const name of brokerMetadata.files) {
    if (name === "dist") continue;
    try { await cp(join(broker, name), join(brokerOutput, name), { recursive: true, errorOnExist: true, force: false }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
const query = join(tern, "query");
if (buildTern) {
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
}
for (const directory of [join(brokerOutput, "dist"), ...(buildTern ? [query] : [])]) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "ntn-skills.mjs"), cliCode);
  await writeFile(join(directory, "ntn-skills-sdk.mjs"), sdkCode);
  await writeFile(join(directory, "ntn-skills-runtime.json"), JSON.stringify(runtimeManifest, null, 2) + "\n");
  await writeFile(join(directory, "NOTICES.txt"), [...licenseFiles].map(([name, license]) => `Bundled dependency: ${name}\n${license.trim()}\n`).join("\n"));
  const builtinRoot = join(directory, "builtin-skills");
  try {
    await readdir(builtinRoot);
    const retained = await mkdtemp(join(tmpdir(), "broker-build-builtins-"));
    await rename(builtinRoot, join(retained, "builtin-skills"));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
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
for (const path of [join(brokerOutput, "dist/completion.mjs"), ...(buildTern ? [join(query, "completion.mjs")] : [])]) {
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
  await writeFile(join(brokerOutput, name), projected);
}
if (buildTern) {
  await copyFile(join(root, "LICENSE"), join(tern, "LICENSE"));
  const manifest = await readFile(join(tern, "plugin.toml"), "utf8");
  const metadata = JSON.parse(await readFile(join(tern, "package.json"), "utf8"));
  if (!manifest.includes(`version = "${metadata.version}"`)) throw new Error("Tern package and manifest versions differ");
}
console.log(buildTern ? "Built standalone broker query and Tern plugin query" : `Built standalone broker package at ${brokerOutput}`);
