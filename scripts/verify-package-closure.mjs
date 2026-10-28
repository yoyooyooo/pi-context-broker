import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const official = ["effect", "@effect/platform-node", "@effect/platform-node-shared", "@effect/sql-sqlite-node"];
export async function verifyPackageClosure({ brokerArchive, ternArchive, brokerManifest, base }) {
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
  const consumer = join(base, "consumer");
  const staged = join(base, "staged");
  const tern = join(base, "tern");
  for (const directory of [consumer, staged, tern]) await mkdir(directory);
  await run(["tar", "-xzf", resolve(brokerArchive), "-C", staged], base);
  if (brokerManifest) {
    // Dependency-only diagnostic: preserve all frozen executable/resource bytes.
    await cp(resolve(brokerManifest), join(staged, "package/package.json"));
    await run(["npm", "pack", "--ignore-scripts", "--pack-destination", staged], join(staged, "package"));
    brokerArchive = join(staged, (await readdir(staged)).find(name => name.endsWith(".tgz")));
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "strict-broker-consumer", private: true, dependencies: { "pi-context-broker": `file:${resolve(brokerArchive)}` } }, null, 2));
  await run(["npm", "install", "--omit=dev", "--no-audit", "--no-fund"], consumer);
  const installed = join(consumer, "node_modules/pi-context-broker");
  for (const host of ["@earendil-works/pi-coding-agent", "@oh-my-pi/pi-coding-agent"]) {
    assert.equal(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).peerDependenciesMeta[host].optional, true);
    await assert.rejects(readFile(join(consumer, "node_modules", host, "package.json")), { code: "ENOENT" });
  }
  await run(["tar", "-xzf", resolve(ternArchive), "-C", tern], base);
  const query = join(tern, "query");
  // Reconcile from declarations, not prepopulated node_modules or the frozen override lock.
  const metadata = JSON.parse(await readFile(join(query, "package.json"), "utf8"));
  delete metadata.overrides;
  await writeFile(join(query, "package.json"), JSON.stringify(metadata, null, 2));
  await rm(join(query, "node_modules"), { recursive: true, force: true });
  await rm(join(query, "package-lock.json"), { force: true });
  await run(["npm", "install", "--omit=dev", "--no-audit", "--no-fund"], query);
  await run(["npm", "ls", "--all", "--omit=dev", "--json"], consumer);
  await run(["npm", "ls", "--all", "--omit=dev", "--json"], query);
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
    const ternRoot = join(query, "node_modules", name);
    const npmVersion = JSON.parse(await readFile(join(npmRoot, "package.json"), "utf8")).version;
    const ternVersion = JSON.parse(await readFile(join(ternRoot, "package.json"), "utf8")).version;
    assert.equal(npmVersion, "4.0.5");
    assert.equal(ternVersion, npmVersion);
    const npmFiles = await inventory(npmRoot);
    const ternFiles = await inventory(ternRoot);
    assert.deepEqual(ternFiles, npmFiles, `${name}: official package byte mismatch`);
    inventories[name] = { version: npmVersion, files: npmFiles };
  }
  await writeFile(join(base, "official-inventory.json"), JSON.stringify(inventories, null, 2) + "\n");
  assert.deepEqual(await readFile(join(installed, "dist/ntn-skills.mjs")), await readFile(join(query, "ntn-skills.mjs")));
  const npmBuiltins = join(installed, "dist/builtin-skills");
  const ternBuiltins = join(query, "builtin-skills");
  const builtinNames = ["ntn-skills", "ntn-skills-maintain", "ntn-skills-sync"];
  assert.deepEqual((await readdir(npmBuiltins)).sort(), builtinNames);
  assert.deepEqual((await readdir(ternBuiltins)).sort(), builtinNames);
  assert.deepEqual(await inventory(npmBuiltins), await inventory(ternBuiltins), "Broker and Tern must carry identical builtin instructions and resources");
  for (const name of builtinNames) {
    assert.match(await readFile(join(npmBuiltins, name, "SKILL.md"), "utf8"), /^---\n/);
    assert.ok((await readdir(join(npmBuiltins, name, "references"))).length > 0, `${name}: bundled references are missing`);
  }
  for (const retired of [join(installed, "src/save-workflow/SKILL.md"), join(tern, "builtin.luau"), join(tern, "src/save-workflow/SKILL.md")]) {
    await assert.rejects(readFile(retired), { code: "ENOENT" });
  }
  for (const [label, entry, builtinRoot] of [
    ["npm", join(installed, "dist/ntn-skills.mjs"), npmBuiltins],
    ["tern", join(query, "ntn-skills.mjs"), ternBuiltins],
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
    assert.equal((await cli(["operation", "list"])).ok, true);
    assert.equal((await cli(["ctl", "backup", "--output", join(base, label + "-backup")])).verified, true);
  }
  console.log(`Strict default-peer Broker/Tern closure verified: ${base}`);
  return { base, installed, tern, builtins: { names: builtinNames, npmRoot: npmBuiltins, ternRoot: ternBuiltins } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [brokerArchive, ternArchive, brokerManifest] = process.argv.slice(2);
  assert.ok(brokerArchive && ternArchive, "Usage: node scripts/verify-package-closure.mjs BROKER.tgz TERN.tar.gz [dependency-only-package.json]");
  await verifyPackageClosure({ brokerArchive, ternArchive, brokerManifest });
}
