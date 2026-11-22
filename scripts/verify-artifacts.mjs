import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPackageClosure, verifyBundledNotices, verifyBundledRuntime } from "./verify-package-closure.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const usage = "Usage: node scripts/verify-artifacts.mjs --fixture CURRENT_FIXTURE_JSON --source-http-helper ABSOLUTE_HELPER";
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1];
  assert.ok(["--fixture", "--source-http-helper"].includes(key) && !options.has(key) && value && isAbsolute(value), usage);
  options.set(key, await realpath(value));
}
assert.equal(options.size, 2, usage);
const fixture = JSON.parse(await readFile(options.get("--fixture"), "utf8"));
assert.equal(fixture.version, 2);
assert.equal(fixture.kind, "current-notion-service");
assert.ok(!("snapshots" in fixture), "Historical seeded fixtures are retired");
const selectedEntry = process.env.NTN_SKILLS_BUILD_ENTRY;
assert.ok(selectedEntry && isAbsolute(selectedEntry), "NTN_SKILLS_BUILD_ENTRY must select the current paired CLI");
const base = await realpath(await mkdtemp(join(tmpdir(), "broker-artifacts-")));
console.log("Artifact workspace retained: " + base);
const report = { version: 2, status: "running", startedAt: new Date().toISOString(),
  boundary: "Independently installed Broker and SDK v2 with controlled current Notion HTTP.",
  notRun: ["Pi session", "provider/model", "live Notion", "OMP", "Tern"],
  currentSdk: { status: "not_run" } };
const saveReport = () => writeFile(join(base, "manifest.json"), JSON.stringify(report, null, 2) + "\n");
const commands = [];
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { cwd: base, encoding: "utf8", timeout: 360_000,
    maxBuffer: 32 * 1024 * 1024, ...options });
  commands.push({ command, argv, status: result.status, stdout: result.stdout, stderr: result.stderr });
  if (result.error || result.status !== 0) throw new Error(command + " failed: "
    + (result.error?.message ?? result.status) + "\n" + result.stdout + "\n" + result.stderr);
  return result.stdout;
}
async function runtimePath(directory, entry) {
  assert.ok(typeof entry === "string" && !isAbsolute(entry));
  const path = resolve(directory, entry), local = relative(directory, path);
  assert.ok(local && local !== ".." && !local.startsWith("../"));
  assert.ok((await stat(path)).isFile());
  return path;
}
const identity = async path => {
  const bytes = await readFile(path);
  return { path: await realpath(path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
};
async function selectedBuildInput(entry) {
  let directory = dirname(entry);
  while (true) {
    const path = join(directory, "package.json");
    let metadata;
    try { metadata = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (metadata?.name === "ntn-skills") {
      const exported = metadata.exports?.["./sdk"];
      const sdk = typeof exported === "string" ? exported : exported?.import;
      return { package: metadata.name, version: metadata.version, manifest: await identity(path),
        cli: await identity(entry), sdk: await identity(await runtimePath(directory, sdk)),
        notices: await identity(await runtimePath(directory, "THIRD_PARTY_NOTICES.md")) };
    }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, "Explicit build entry must belong to an ntn-skills package");
    directory = parent;
  }
}
async function verifyDocumentLinks(directory, entries) {
  const pending = [...entries], visited = new Set();
  while (pending.length) {
    const entry = pending.pop(), file = await runtimePath(directory, entry);
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
        const content = await readFile(destination, "utf8");
        const anchors = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map(heading => heading[1].toLowerCase()
          .replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-"));
        assert.ok(anchors.includes(decodeURIComponent(fragment)), "Missing document anchor: " + entry + " -> " + match[1]);
      }
      pending.push(local);
    }
  }
}
await saveReport();
try {
  const selected = await selectedBuildInput(selectedEntry);
  report.buildInput = selected;
  const output = join(base, "archives");
  await mkdir(output);
  run("bun", ["scripts/pack.mjs", "--target", "broker", "--out-dir", output], { cwd: root });
  assert.deepEqual(await selectedBuildInput(selectedEntry), selected, "Build input changed while packaging");
  const archives = (await readdir(output)).filter(name => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  assert.equal((await readdir(output)).some(name => name.includes("tern")), false);
  const archive = join(output, archives[0]);
  const closure = await verifyPackageClosure({ brokerArchive: archive, base: join(base, "strict-closure") });
  const installed = closure.installed;
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  report.package = { name: metadata.name, version: metadata.version, installed, archive: await identity(archive) };
  report.notices = verifyBundledNotices({ selectedNoticesBytes: await readFile(selected.notices.path),
    bundledNoticesBytes: await readFile(join(installed, "dist/NOTICES.txt")), expectedSha256: selected.notices.sha256 });
  const runtime = JSON.parse(await readFile(join(installed, "dist/ntn-skills-runtime.json"), "utf8"));
  report.runtime = { ...runtime, hashes: verifyBundledRuntime({ manifest: runtime, expectedVersion: selected.version,
    cliBytes: await readFile(join(installed, "dist/ntn-skills.mjs")),
    sdkBytes: await readFile(join(installed, "dist/ntn-skills-sdk.mjs")) }) };
  const sdk = await import(pathToFileURL(join(installed, "dist/ntn-skills-sdk.mjs")).href);
  assert.equal(sdk.SDK_VERSION, 2);
  for (const name of ["listCatalog", "consume", "readSkill", "readResources"])
    assert.equal(typeof sdk[name], "function", name + " must be exported by the actual installed SDK");
  await verifyDocumentLinks(installed, ["README.md", "README.zh-CN.md", "docs/reference.md", "docs/reference.zh-CN.md", "CONTRIBUTING.md"]);

  // The pinned Pi package provides Jiti only. This does not start or validate a Pi host.
  const loader = join(base, "loader");
  await mkdir(loader);
  await writeFile(join(loader, "package.json"), JSON.stringify({ name: "current-broker-loader", private: true }));
  const loaderHome = join(loader, "home");
  await mkdir(loaderHome);
  const loaderEnv = { PATH: dirname(process.execPath) + ":/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: loaderHome, TMPDIR: base, LANG: "en_US.UTF-8" };
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact",
    "@earendil-works/pi-coding-agent@1.5.2"], { cwd: loader, env: loaderEnv });
  const piPackage = join(loader, "node_modules/@earendil-works/pi-coding-agent/package.json");
  assert.equal(JSON.parse(await readFile(piPackage, "utf8")).version, "1.5.2");
  const sdkOut = join(base, "current-sdk");
  run(process.execPath, [join(root, "scripts/verify-notion-sdk-installed.mjs"),
    "--package", installed, "--fixture", options.get("--fixture"),
    "--source-http-helper", options.get("--source-http-helper"),
    "--pi-package", piPackage, "--out", sdkOut]);
  report.currentSdk = JSON.parse(await readFile(join(sdkOut, "result.json"), "utf8"));
  assert.equal(report.currentSdk.status, "passed");
  assert.equal(report.currentSdk.semantic_writes, 0);
  assert.equal(report.currentSdk.child_starts, 0);
  assert.deepEqual(report.currentSdk.not_run, report.notRun);
  report.status = "passed";
  console.log("Artifact verification passed: installed Broker/SDK v2 current HTTP consumption; Pi session/provider/model not run.");
} catch (error) {
  report.status = "failed"; report.error = { code: error.code ?? error.name, message: error.message };
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(base, "commands.json"), JSON.stringify(commands, null, 2) + "\n");
  await saveReport();
}
