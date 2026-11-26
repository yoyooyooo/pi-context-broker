import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const official = ["effect", "@effect/platform-node", "@effect/platform-node-shared", "@effect/sql-sqlite-node"];

/** The same archive-to-installed byte check is used by daily and isolated candidates. */
export async function verifyArchiveInstallation(root, archive, expectedHash) {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const inside = (base, path) => { const local = relative(base, path); return local === '' || local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local); };
  const identity = async path => { const bytes = await readFile(path); return { path, realpath: await realpath(path), bytes: bytes.length, sha256: hash(bytes) }; };
  assert.ok(isAbsolute(root) && isAbsolute(archive));
  const canonicalRoot = await realpath(root), archiveIdentity = await identity(archive);
  assert.equal(archiveIdentity.sha256, expectedHash, 'Final package archive SHA mismatch');
  const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split('\n').filter(value => value && !value.endsWith('/'));
  assert.ok(entries.length > 0, 'A package archive must contain files');
  const files = [];
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/'));
    const local = entry.slice('package/'.length), path = resolve(root, local);
    assert.ok(inside(root, path), 'Unsafe package member');
    assert.ok(inside(canonicalRoot, await realpath(path)), 'A package member escapes the installed package');
    const packed = execFileSync('tar', ['-xOf', archive, entry], { maxBuffer: 32 * 1024 * 1024 });
    const actual = await identity(path);
    assert.equal(actual.sha256, hash(packed), `Installed package differs: ${local}`);
    files.push({ path: local, sha256: actual.sha256, bytes: actual.bytes, runtime: /^(?:src|dist)\//u.test(local) || local === 'package.json' });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, archive: archiveIdentity, file_count: files.length, files, sha256: hash(JSON.stringify(files)) };
}
export function verifyBundledNotices({ selectedNoticesBytes, bundledNoticesBytes, expectedSha256 }) {
  assert.ok(selectedNoticesBytes instanceof Uint8Array && selectedNoticesBytes.length > 0, 'Selected CLI THIRD_PARTY_NOTICES.md must contain complete nonempty bytes');
  assert.ok(bundledNoticesBytes instanceof Uint8Array, 'Bundled NOTICES.txt bytes are required');
  assert.match(expectedSha256, /^[a-f0-9]{64}$/u);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const selected = Buffer.from(selectedNoticesBytes), bundled = Buffer.from(bundledNoticesBytes);
  assert.equal(hash(selected), expectedSha256, 'Selected CLI third-party notices changed');
  assert.ok(bundled.indexOf(selected) >= 0, 'Bundled NOTICES.txt must contain the complete selected CLI THIRD_PARTY_NOTICES.md unchanged');
  return { source_sha256: expectedSha256, source_bytes: selected.length, bundled_sha256: hash(bundled), bundled_bytes: bundled.length };
}
export function verifyBundledRuntime({ manifest, cliBytes, sdkBytes, refBytes, expectedVersion }) {
  assert.equal(manifest.version, 1, "Unknown bundled runtime manifest");
  assert.equal(manifest.package, "ntn-skills", "Unexpected bundled package identity");
  assert.equal(manifest.package_version, expectedVersion, "Bundled runtime must match its frozen build input version");
  assert.equal(manifest.sdk_version, 3, "Only the current SDK v3 is supported");
  assert.equal(manifest.skill_ref_version, 2, "Only the current Skill reference protocol is supported");
  assert.ok(refBytes instanceof Uint8Array && refBytes.length > 0, "The selected pure reference artifact is required");
  for (const capability of ["consumer_contract_version", "consumption_effects_version", "catalog_directory_contract_version", "read_output_proof_version", "resource_read_contract_version", "resource_read_effects_version", "content_search_contract_version", "candidate_snapshot_contract_version"])
    assert.equal(manifest[capability], 1, `Current runtime capability is required: ${capability}`);
  const hashes = { cli: createHash("sha256").update(cliBytes).digest("hex"), sdk: createHash("sha256").update(sdkBytes).digest("hex"), ref: createHash("sha256").update(refBytes).digest("hex") };
  assert.equal(manifest.cli_sha256, hashes.cli, "Bundled CLI bytes do not match its frozen runtime manifest");
  assert.equal(manifest.sdk_sha256, hashes.sdk, "Bundled SDK bytes do not match its frozen runtime manifest");
  assert.equal(manifest.ref_sha256, hashes.ref, "Bundled reference bytes do not match the frozen runtime manifest");
  return hashes;
}
export function packageInstallationEnvironment({ home, base, cache, proxy }) {
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: base, LANG: "en_US.UTF-8" };
  if (cache !== undefined) {
    assert.ok(isAbsolute(cache), "An installation download cache must be an absolute path");
    env.npm_config_cache = cache;
    env.npm_config_prefer_offline = "true";
  }
  if (proxy) {
    const url = new URL(proxy);
    assert.ok(["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash, "The installation proxy must be a credential-free HTTP(S) origin");
    env.npm_config_proxy = url.origin;
    env.npm_config_https_proxy = url.origin;
  }
  return env;
}
export async function verifyPackageClosure({ brokerArchive, ternArchive, brokerManifest, base, downloads = {} }) {
  base ??= await mkdtemp(join(tmpdir(), "broker-strict-closure-"));
  await mkdir(base, { recursive: true });
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  // No user npm config, NODE_PATH, NODE_OPTIONS, alternate CLI or host helper.
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: base, LANG: "en_US.UTF-8" };
  // Only npm gets the selected public download cache/transport. Runtime checks
  // retain the empty HOME and do not inherit either these settings or the host.
  const installEnv = packageInstallationEnvironment({ home, base, ...downloads });
  const receipts = [];
  async function run(argv, cwd, expectedExit = 0) {
    const result = spawnSync(argv[0], argv.slice(1), { cwd, env: argv[0] === "npm" ? installEnv : env, encoding: "utf8", timeout: 360_000, maxBuffer: 32 * 1024 * 1024 });
    const receipt = { argv, cwd, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message };
    receipts.push(receipt);
    await writeFile(join(base, "commands.json"), JSON.stringify(receipts, null, 2) + "\n");
    assert.equal(result.status, expectedExit, `${argv.join(" ")}: ${receipt.stderr}; ${receipt.error ?? ""}`);
    return receipt.stdout;
  }
  await run([process.execPath, "--version"], base);
  await run(["npm", "--version"], base);
  await run(["npm", "config", "get", "registry"], base);
  const consumer = join(base, "consumer");
  const staged = join(base, "staged");
  const tern = ternArchive ? join(base, "tern") : undefined;
  for (const directory of [consumer, staged, ...(tern ? [tern] : [])]) await mkdir(directory);
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
    for (const file of ["ntn-skills.mjs", "ntn-skills-sdk.mjs", "ntn-skills-ref.cjs", "ntn-skills-runtime.json"]) {
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
    const cliText = (args, expectedExit = 0) => run([process.execPath, entry, ...args], cwd, expectedExit);
    const cli = async (args, expectedExit = 0) => JSON.parse(await cliText(args, expectedExit));
    for (const command of ["list", "read", "use", "files", "export"])
      assert.equal((await cli(["schema", command])).ok, true);
    const currentImport = await cli(["schema", "ctl", "library", "import"]);
    assert.equal(currentImport.ok, true, `${label}: current Skill import schema is unavailable`);
    assert.deepEqual(currentImport.command, ["ctl", "library", "import"]);
    for (const [name, kind, type, required] of [
      ["input", "argument", "string", true],
      ["library", "flag", "string", true],
      ["skill-id", "flag", "string", true],
      ["operation", "flag", "string", false],
      ["resume", "flag", "boolean", false],
      ["dry-run", "flag", "boolean", false],
      ["max-requests", "flag", "integer", false],
      ["max-bytes", "flag", "integer", false],
      ["timeout", "flag", "integer", false],
    ]) {
      const parameter = currentImport.schema.parameters.find(parameter => parameter.name === name);
      assert.deepEqual(parameter && { kind: parameter.kind, type: parameter.type, required: parameter.required },
        { kind, type, required }, `${label}: current Skill import parameter ${name} has an invalid schema`);
    }
    assert.ok(!currentImport.schema.parameters.some(parameter => parameter.name === "entry"), `${label}: retired table-entry selection must not remain available`);
    // Package reads work with an empty HOME, outside the checkout and without
    // a global CLI, Notion connection or a separate Skill installation.
    const homeBefore = (await readdir(home, { recursive: true })).sort();
    const catalog = await cli(["skills", "list", "--json"]);
    assert.equal(catalog.ok, true);
    assert.equal(catalog.source, "builtin");
    assert.equal(catalog.count, builtinNames.length);
    assert.deepEqual(catalog.skills.map(skill => skill.id).sort(), builtinNames.map(name => "notion/" + name));
    assert.deepEqual(catalog.skills.map(skill => skill.name).sort(), builtinNames);
    assert.ok(catalog.skills.every(skill => !Object.hasOwn(skill, "installation")), `${label}: packaged Skills must not expose an installation lifecycle`);
    assert.deepEqual(await cli(["skills", "--json"]), catalog);
    const rootPath = await cli(["skills", "path", "--json"]);
    assert.equal(rootPath.ok, true);
    assert.equal(rootPath.path, await realpath(builtinRoot), `${label}: the embedded CLI must locate its own package directory`);
    for (const name of builtinNames) {
      const directory = join(builtinRoot, name);
      const resources = (await readdir(join(directory, "references"), { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
        .map(entry => "references/" + entry.name).sort();
      assert.ok(resources.length > 0, `${label}/${name}: no readable packaged reference`);
      assert.equal(await cliText(["skills", "get", name]), await readFile(join(directory, "SKILL.md"), "utf8"), `${label}/${name}: default output must be exact Markdown`);
      assert.equal(await cliText(["skills", "path", name]), await realpath(directory) + "\n", `${label}/${name}: path must name this installed Skill`);
      for (const file of ["SKILL.md", ...resources]) {
        const result = await cli(["skills", "get", name, ...(file === "SKILL.md" ? [] : ["--path", file]), "--json"]);
        assert.equal(result.ok, true, `${label}/${name}/${file}: package read failed`);
        assert.equal(result.builtin.origin, "builtin");
        assert.equal(result.builtin.name, name);
        assert.equal(result.path, file);
        assert.equal(result.content, await readFile(join(directory, file), "utf8"), `${label}/${name}/${file}: package read did not consume the exact distributed bytes`);
      }
      const complete = await cli(["skills", "get", name, "--full", "--json"]);
      assert.equal(complete.ok, true);
      assert.deepEqual(complete.files.map(file => file.path).sort(), ["SKILL.md", ...resources].sort());
      for (const file of complete.files) {
        const bytes = await readFile(join(directory, file.path));
        assert.equal(file.bytes, bytes.length);
        assert.equal(file.content, bytes.toString("utf8"), `${label}/${name}/${file.path}: --full must include complete supporting files`);
      }
    }
    assert.deepEqual((await readdir(home, { recursive: true })).sort(), homeBefore, `${label}: packaged Skills commands must not create local installation state`);
    assert.equal((await cli(["ctl", "config", "set", "cache_policy.read_max_age_ms", "0"])).ok, true);
    assert.equal((await cli(["ctl", "config", "show"])).config.cache_policy.read_max_age_ms, 0);
    // Retired mutation/history routes must not return a usable schema.
    for (const command of ["operation", "ctl backup", "ctl repair", "ctl sources", "ctl builtin", "skills install", "skills update", "skills status", "skills export"])
      assert.equal((await cli(["schema", ...command.split(" ")], 2)).ok, false);
  }
  console.log(`Strict default-peer ${tern ? "Broker/Tern" : "Broker"} closure verified: ${base}`);
  return { base, installed, tern, builtins: { names: builtinNames, npmRoot: npmBuiltins, ternRoot: ternBuiltins } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [brokerArchive, ternArchive, brokerManifest] = process.argv.slice(2);
  assert.ok(brokerArchive, "Usage: node scripts/verify-package-closure.mjs BROKER.tgz [TERN.tar.gz] [dependency-only-package.json]");
  await verifyPackageClosure({ brokerArchive, ternArchive, brokerManifest,
    downloads: { cache: process.env.npm_config_cache, proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY } });
}
