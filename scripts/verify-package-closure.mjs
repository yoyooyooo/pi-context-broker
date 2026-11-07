import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const official = ["effect", "@effect/platform-node", "@effect/platform-node-shared", "@effect/sql-sqlite-node"];
const registry = "https://registry.npmjs.org";
export function verifyReleaseCliInput({ brokerManifest, installedManifest, fixtureManifest, buildEntry }) {
  assert.ok(!buildEntry, "Publication must use the declared ntn-skills dependency without NTN_SKILLS_BUILD_ENTRY");
  const version = brokerManifest.devDependencies?.["ntn-skills"];
  assert.match(version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Publication requires an exact stable ntn-skills dependency");
  assert.equal(installedManifest.name, "ntn-skills");
  assert.equal(installedManifest.version, version, "Installed ntn-skills must match the declared release dependency");
  const sdkExport = installedManifest.exports?.["./sdk"];
  const sdkImport = typeof sdkExport === "string" ? sdkExport : sdkExport?.import;
  assert.ok(typeof sdkImport === "string" && sdkImport.startsWith("./"), `Declared ntn-skills@${version} has no Node ESM SDK; publish a compatible CLI and update the exact dependency and lockfile before Broker publication`);
  assert.equal(fixtureManifest.name, "ntn-skills");
  assert.equal(fixtureManifest.version, version, "Pinned CLI fixture source must match the declared release dependency version");
  return { package: "ntn-skills", version, fixtureVersion: fixtureManifest.version };
}
export function brokerRegistryVersion(spec) {
  const match = /^pi-context-broker@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(spec ?? "");
  assert.ok(match, "Registry verification requires an exact pi-context-broker@x.y.z version");
  return match[1];
}
export function verifyRegistryArtifact({ spec, metadata, archiveBytes, expectedBytes }) {
  assert.equal(metadata.name, "pi-context-broker");
  assert.equal(metadata.version, brokerRegistryVersion(spec));
  const integrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
  assert.equal(metadata["dist.integrity"], integrity, "Registry integrity does not match the downloaded archive");
  assert.deepEqual(archiveBytes, expectedBytes, "Registry archive differs from the verified release candidate");
  return integrity;
}
async function packageInventory(root) {
  const files = {};
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const name = prefix + entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, name + "/");
      else if (entry.isFile()) files[name] = createHash("sha256").update(await readFile(path)).digest("hex");
      else if (entry.isSymbolicLink()) files[name] = { link: await readlink(path) };
    }
  }
  await visit(root);
  return files;
}
export async function verifyInstalledArchive({ staged, installed }) {
  const files = await packageInventory(staged);
  assert.deepEqual(await packageInventory(installed), files, "Installed package must contain exactly the candidate files, without stale upgrade files");
  return Object.keys(files).length;
}
export async function installBrokerConsumer({ consumer, home, target, upgradeFrom, run }) {
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "strict-broker-consumer", private: true }, null, 2) + "\n");
  const install = spec => run(["npm", "install", "--save-exact", "--omit=dev", "--no-audit", "--no-fund", "--registry", registry, spec], consumer);
  const preserved = [];
  if (upgradeFrom) {
    const previousVersion = brokerRegistryVersion(upgradeFrom);
    await install(upgradeFrom);
    assert.equal(JSON.parse(await readFile(join(consumer, "node_modules/pi-context-broker/package.json"), "utf8")).version, previousVersion);
    const agentDir = join(home, ".pi/agent");
    for (const [path, contents] of [
      [join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-context-broker", "npm:other-user-package"], defaultTools: ["+tool_search"] }, null, 2) + "\n"],
      [join(agentDir, "context-broker/config.yml"), "skillRoots: []\nsources: []\n"],
    ]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
      preserved.push({ path, contents });
    }
  }
  await install(target);
  for (const { path, contents } of preserved) assert.equal(await readFile(path, "utf8"), contents, `Package upgrade changed user configuration: ${path}`);
  return { mode: upgradeFrom ? "upgrade" : "fresh", ...(upgradeFrom ? { from: upgradeFrom } : {}), target, preservedConfigurations: preserved.map(({ path }) => path) };
}
export function verifyBundledRuntime({ manifest, cliBytes, sdkBytes, expectedVersion }) {
  assert.equal(manifest.version, 1, "Unknown bundled runtime manifest");
  assert.equal(manifest.package, "ntn-skills", "Unexpected bundled package identity");
  assert.equal(manifest.package_version, expectedVersion, "Bundled runtime must match its frozen build input version");
  const hashes = { cli: createHash("sha256").update(cliBytes).digest("hex"), sdk: createHash("sha256").update(sdkBytes).digest("hex") };
  assert.equal(manifest.cli_sha256, hashes.cli, "Bundled CLI bytes do not match its frozen runtime manifest");
  assert.equal(manifest.sdk_sha256, hashes.sdk, "Bundled SDK bytes do not match its frozen runtime manifest");
  return hashes;
}
export async function verifyPackageClosure({ brokerArchive, ternArchive, brokerManifest, registryPackage, upgradeFrom, base }) {
  if (registryPackage) brokerRegistryVersion(registryPackage);
  if (upgradeFrom) brokerRegistryVersion(upgradeFrom);
  assert.ok(!registryPackage || brokerArchive && !ternArchive && !brokerManifest, "Registry verification requires the expected Broker archive without Tern or manifest overrides");
  assert.ok(!upgradeFrom || !ternArchive && !brokerManifest, "Upgrade verification requires the unmodified Broker candidate without Tern");
  base ??= await mkdtemp(join(tmpdir(), "broker-strict-closure-"));
  await mkdir(base, { recursive: true });
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  // No user npm config, NODE_PATH, NODE_OPTIONS, alternate CLI or host helper.
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: base, LANG: "en_US.UTF-8" };
  const receipts = [];
  async function run(argv, cwd) {
    const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: "utf8", timeout: 360_000, maxBuffer: 32 * 1024 * 1024 });
    const receipt = { argv, cwd, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message };
    receipts.push(receipt);
    await writeFile(join(base, "commands.json"), JSON.stringify(receipts, null, 2) + "\n");
    assert.equal(result.status, 0, `${argv.join(" ")}: ${receipt.stderr}; ${receipt.error ?? ""}`);
    return receipt.stdout;
  }
  await run([process.execPath, "--version"], base);
  await run(["npm", "--version"], base);
  await run(["npm", "config", "get", "registry"], base);
  let distribution;
  if (registryPackage) {
    const archives = join(base, "registry-archive");
    await mkdir(archives);
    const metadata = JSON.parse(await run(["npm", "view", registryPackage, "name", "version", "dist.integrity", "--json", "--registry", registry], base));
    const packed = JSON.parse(await run(["npm", "pack", registryPackage, "--ignore-scripts", "--json", "--pack-destination", archives, "--registry", registry], base));
    assert.equal(packed.length, 1);
    assert.equal(packed[0].filename, `pi-context-broker-${brokerRegistryVersion(registryPackage)}.tgz`);
    const downloaded = join(archives, packed[0].filename);
    const integrity = verifyRegistryArtifact({ spec: registryPackage, metadata, archiveBytes: await readFile(downloaded), expectedBytes: await readFile(resolve(brokerArchive)) });
    distribution = { package: registryPackage, registry, integrity, expectedArchive: resolve(brokerArchive) };
    brokerArchive = downloaded;
  }
  const consumer = join(base, "consumer");
  const staged = join(base, "staged");
  const tern = ternArchive ? join(base, "tern") : undefined;
  for (const directory of [consumer, staged, ...(tern ? [tern] : [])]) await mkdir(directory);
  await run(["tar", "-xzf", resolve(brokerArchive), "-C", staged], base);
  const packedManifest = JSON.parse(await readFile(join(staged, "package/package.json"), "utf8"));
  assert.equal(packedManifest.name, "pi-context-broker");
  if (registryPackage) assert.equal(packedManifest.version, brokerRegistryVersion(registryPackage));
  if (brokerManifest) {
    // Dependency-only diagnostic: preserve all frozen executable/resource bytes.
    await cp(resolve(brokerManifest), join(staged, "package/package.json"));
    await run(["npm", "pack", "--ignore-scripts", "--pack-destination", staged], join(staged, "package"));
    brokerArchive = join(staged, (await readdir(staged)).find(name => name.endsWith(".tgz")));
  }
  const installation = await installBrokerConsumer({ consumer, home, target: registryPackage ?? `file:${resolve(brokerArchive)}`, upgradeFrom, run });
  const installed = join(consumer, "node_modules/pi-context-broker");
  installation.publishedFiles = await verifyInstalledArchive({ staged: join(staged, "package"), installed });
  for (const host of ["@earendil-works/pi-coding-agent", "@oh-my-pi/pi-coding-agent"]) {
    assert.equal(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).peerDependenciesMeta[host].optional, true);
    await assert.rejects(readFile(join(consumer, "node_modules", host, "package.json")), { code: "ENOENT" });
  }
  const query = tern ? join(tern, "query") : undefined;
  if (tern) {
    await run(["tar", "-xzf", resolve(ternArchive), "-C", tern], base);
    // Reconcile declarations in the owned extraction while retaining its originals.
    const metadata = JSON.parse(await readFile(join(query, "package.json"), "utf8"));
    delete metadata.overrides;
    await cp(join(query, "package.json"), join(query, "package.before-install.json"));
    await writeFile(join(query, "package.json"), JSON.stringify(metadata, null, 2));
    for (const name of ["node_modules", "package-lock.json"]) {
      try { await rename(join(query, name), join(query, name + ".before-install")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await run(["npm", "install", "--omit=dev", "--no-audit", "--no-fund"], query);
  }
  await run(["npm", "ls", "--all", "--omit=dev", "--json"], consumer);
  if (query) await run(["npm", "ls", "--all", "--omit=dev", "--json"], query);
  async function inventory(root) {
    const files = {};
    async function visit(directory, prefix = "") {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) await visit(join(directory, entry.name), name + "/");
        else if (entry.isFile()) files[name] = createHash("sha256").update(await readFile(join(directory, entry.name))).digest("hex");
      }
    }
    await visit(root);
    return files;
  }
  const inventories = {};
  for (const name of official) {
    const npmRoot = join(consumer, "node_modules", name);
    const npmVersion = JSON.parse(await readFile(join(npmRoot, "package.json"), "utf8")).version;
    assert.equal(npmVersion, "4.0.5");
    const npmFiles = await inventory(npmRoot);
    if (query) {
      const ternRoot = join(query, "node_modules", name);
      const ternVersion = JSON.parse(await readFile(join(ternRoot, "package.json"), "utf8")).version;
      assert.equal(ternVersion, npmVersion);
      assert.deepEqual(await inventory(ternRoot), npmFiles, `${name}: official package byte mismatch`);
    }
    inventories[name] = { version: npmVersion, files: npmFiles };
  }
  await writeFile(join(base, "official-inventory.json"), JSON.stringify(inventories, null, 2) + "\n");
  if (query) {
    for (const file of ["ntn-skills.mjs", "ntn-skills-sdk.mjs", "ntn-skills-runtime.json"]) {
      assert.deepEqual(await readFile(join(installed, "dist", file)), await readFile(join(query, file)),
        `${file}: Broker and Tern must ship the same complete consumption runtime`);
    }
  }
  const npmBuiltins = join(installed, "dist/builtin-skills");
  const ternBuiltins = query ? join(query, "builtin-skills") : undefined;
  const builtinNames = ["ntn-skills", "ntn-skills-maintain", "ntn-skills-sync"];
  assert.deepEqual((await readdir(npmBuiltins)).sort(), builtinNames);
  if (ternBuiltins) {
    assert.deepEqual((await readdir(ternBuiltins)).sort(), builtinNames);
    assert.deepEqual(await inventory(npmBuiltins), await inventory(ternBuiltins), "Broker and Tern must carry identical builtin instructions and resources");
  }
  for (const name of builtinNames) {
    assert.match(await readFile(join(npmBuiltins, name, "SKILL.md"), "utf8"), /^---\n/);
    assert.ok((await readdir(join(npmBuiltins, name, "references"))).length > 0, `${name}: bundled references are missing`);
  }
  for (const retired of [join(installed, "src/save-workflow/SKILL.md"), ...(tern ? [join(tern, "builtin.luau"), join(tern, "src/save-workflow/SKILL.md")] : [])]) {
    await assert.rejects(readFile(retired), { code: "ENOENT" });
  }
  for (const [label, entry, builtinRoot] of [
    ["npm", join(installed, "dist/ntn-skills.mjs"), npmBuiltins],
    ...(query ? [["tern", join(query, "ntn-skills.mjs"), ternBuiltins]] : []),
  ]) {
    const cwd = join(base, label + "-cwd");
    await mkdir(cwd);
    const cli = async args => JSON.parse(await run([process.execPath, entry, ...args], cwd));
    assert.equal((await cli(["schema", "read"])).ok, true);
    // These public fallbacks must resolve package resources with an empty HOME,
    // outside the checkout and without a global CLI or installed central Skills.
    const catalog = await cli(["ctl", "builtin", "list"]);
    assert.equal(catalog.ok, true);
    assert.deepEqual(catalog.skills.map(skill => skill.id).sort(), builtinNames.map(name => "notion/" + name));
    assert.ok(catalog.skills.every(skill => skill.installation.state === "not_installed"), `${label}: builtin reads must not require a central installation`);
    for (const name of builtinNames) {
      const directory = join(builtinRoot, name);
      const resources = (await readdir(join(directory, "references"), { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
        .map(entry => "references/" + entry.name).sort();
      assert.ok(resources.length > 0, `${label}/${name}: no readable packaged reference`);
      for (const file of ["SKILL.md", ...resources]) {
        const result = await cli(["ctl", "builtin", "read", "notion/" + name, ...(file === "SKILL.md" ? [] : ["--path", file])]);
        assert.equal(result.ok, true, `${label}/${name}/${file}: package read failed`);
        assert.equal(result.builtin.origin, "builtin");
        assert.equal(result.content, await readFile(join(directory, file), "utf8"), `${label}/${name}/${file}: package fallback did not consume the exact distributed bytes`);
      }
    }
    assert.ok((await cli(["ctl", "builtin", "list"])).skills.every(skill => skill.installation.state === "not_installed"), `${label}: reading packaged resources must not install central Skills`);
    assert.equal((await cli(["ctl", "config", "set", "cache_policy.read_max_age_ms", "0"])).ok, true);
    assert.equal((await cli(["ctl", "config", "show"])).config.cache_policy.read_max_age_ms, 0);
    // The frozen CLI still exposes its retained operation journal at this public path.
    assert.equal((await cli(["operation", "list"])).ok, true);
    assert.equal((await cli(["ctl", "backup", "--output", join(base, label + "-backup")])).verified, true);
  }
  console.log(`Strict default-peer ${tern ? "Broker/Tern" : "Broker"} closure verified: ${base}`);
  return { base, installed, tern, brokerArchive: resolve(brokerArchive), installation, distribution, builtins: { names: builtinNames, npmRoot: npmBuiltins, ternRoot: ternBuiltins } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--release-input") {
    assert.equal(args.length, 2, "Usage: node scripts/verify-package-closure.mjs --release-input CLI_FIXTURE_PACKAGE_JSON");
    const brokerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/context-broker/package.json");
    const require = createRequire(brokerPath);
    const selection = verifyReleaseCliInput({
      brokerManifest: JSON.parse(await readFile(brokerPath, "utf8")),
      installedManifest: JSON.parse(await readFile(require.resolve("ntn-skills/package.json"), "utf8")),
      fixtureManifest: JSON.parse(await readFile(resolve(args[1]), "utf8")),
      buildEntry: process.env.NTN_SKILLS_BUILD_ENTRY,
    });
    const sdk = await import(pathToFileURL(require.resolve("ntn-skills/sdk")).href);
    assert.equal(sdk.SDK_VERSION, 1, "Declared CLI dependency has an incompatible SDK");
    assert.equal(sdk.CONSUMER_CONTRACT_VERSION, 1, "Declared CLI dependency has an incompatible consumer contract");
    assert.equal(sdk.PACKAGE_VERSION, selection.version, "Declared CLI SDK bytes do not match its package version");
    console.log(JSON.stringify({ status: "release-cli-input-valid", ...selection }));
  } else {
    const [brokerArchive, ternArchive, brokerManifest] = args;
    assert.ok(brokerArchive && ternArchive, "Usage: node scripts/verify-package-closure.mjs BROKER.tgz TERN.tar.gz [dependency-only-package.json]");
    await verifyPackageClosure({ brokerArchive, ternArchive, brokerManifest });
  }
}
