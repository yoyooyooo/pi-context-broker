import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { archiveIdentity, compare, publicationDecision, registryDocument, repairGitHubRelease,
  stable, validateManifest, validateProvenance, validateRegistry, validateSource } from "./release-evidence.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const declaredConfig = JSON.parse(readFileSync(join(sourceRoot, ".github/release.config.json"), "utf8"));

function fixture(t, gateExit = 0, configOverrides = {}, npmResponse = {}) {
  // Preserve fixtures for inspection; never permanently delete a temporary repository.
  const sandbox = mkdtempSync(join(tmpdir(), "pi-context-broker-release-"));
  t.diagnostic(`Release fixture retained at ${sandbox}`);
  const repo = join(sandbox, "repo");
  const remote = join(sandbox, "remote.git");
  const bin = join(sandbox, "bin");
  const gateLog = join(sandbox, "gate.json");
  const pushLog = join(sandbox, "push.log");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, ".github"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(join(sourceRoot, "scripts/release.ts"), join(repo, "scripts/release.ts"));

  for (const relPath of declaredConfig.versionFiles) {
    const path = join(repo, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ name: "release-fixture", version: "1.0.0" }, null, 2)}\n`);
  }
  const gateScript = join(repo, "scripts/gate.cjs");
  writeFileSync(gateScript, `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const config = JSON.parse(fs.readFileSync(".github/release.config.json", "utf8"));
fs.writeFileSync(process.env.RELEASE_GATE_LOG, JSON.stringify({
  versions: config.versionFiles.map(path => JSON.parse(fs.readFileSync(path, "utf8")).version),
  branch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim(),
  commits: execFileSync("git", ["rev-list", "--all", "--count"], { encoding: "utf8" }).trim(),
}));
process.exit(Number(process.env.RELEASE_GATE_EXIT));
`);
  const config = {
    ...declaredConfig,
    defaultBranch: "main",
    remote: "origin",
    lockfiles: [],
    lockfileCommand: null,
    checkCommand: [process.execPath, gateScript],
    ...configOverrides,
  };
  writeFileSync(join(repo, ".github/release.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!${process.execPath}\nprocess.stdout.write(process.env.RELEASE_NPM_STDOUT); process.stderr.write(process.env.RELEASE_NPM_STDERR); process.exit(Number(process.env.RELEASE_NPM_EXIT));\n`);
  chmodSync(npm, 0o755);

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    RELEASE_GATE_EXIT: String(gateExit),
    RELEASE_GATE_LOG: gateLog,
    RELEASE_NPM_STDOUT: npmResponse.stdout ?? '["1.0.0"]',
    RELEASE_NPM_STDERR: npmResponse.stderr ?? '',
    RELEASE_NPM_EXIT: String(npmResponse.status ?? 0),
  });
  function git(...args) {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  }
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release Fixture");
  git("config", "user.email", "release-fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("init", "--bare", "--initial-branch=main", remote);
  git("remote", "add", "origin", remote);
  git("add", ".");
  git("commit", "-m", "fixture baseline");
  git("push", "-u", "origin", "main");
  const hook = join(remote, "hooks/pre-receive");
  writeFileSync(hook, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(pushLog)}, "push attempted\\n");\nprocess.exit(1);\n`);
  chmodSync(hook, 0o755);
  const baseline = git("rev-parse", "HEAD");
  const remoteRefs = git("--git-dir", remote, "show-ref");
  function release(...args) {
    return spawnSync("bun", [join(repo, "scripts/release.ts"), ...args], {
      cwd: repo, env, encoding: "utf8", timeout: 30_000,
    });
  }
  function assertRemoteUnchanged() {
    assert.equal(git("--git-dir", remote, "show-ref"), remoteRefs);
    assert.throws(() => readFileSync(pushLog), { code: "ENOENT" });
  }
  function assertNoRelease() {
    assert.equal(git("rev-list", "--all", "--count"), "1");
    assert.equal(git("tag", "--list"), "");
    assert.equal(git("rev-parse", "HEAD"), baseline);
    assertRemoteUnchanged();
  }
  return { git, release, gateLog, baseline, config, repo, remote, sandbox, env, assertNoRelease, assertRemoteUnchanged };
}

function assertGateRan(f) {
  const gate = JSON.parse(readFileSync(f.gateLog, "utf8"));
  assert.deepEqual(gate.versions, f.config.versionFiles.map(() => "1.0.1"));
  assert.ok(gate.branch.startsWith(`${f.config.releaseBranchPrefix}${f.config.tagPrefix}1.0.1-`));
  assert.equal(gate.commits, "1", "checks must run before the release commit");
}

test("failed configured check prevents release commit, tag, and push", t => {
  const f = fixture(t, 23);
  const result = f.release("patch");
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assertGateRan(f);
  f.assertNoRelease();
});

test("successful configured check creates a local release tag with --no-push", t => {
  const f = fixture(t);
  const result = f.release("patch", "--no-push");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assertGateRan(f);
  const tag = `${f.config.tagPrefix}1.0.1`;
  assert.equal(f.git("tag", "--list"), tag);
  assert.equal(f.git("cat-file", "-t", `refs/tags/${tag}`), "tag");
  assert.equal(f.git("rev-list", "--all", "--count"), "2");
  assert.equal(f.git("rev-parse", "HEAD"), f.baseline, "main remains at its original commit");
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("rev-parse", `${tag}^`), f.baseline);
  for (const relPath of f.config.versionFiles) {
    assert.equal(JSON.parse(f.git("show", `${tag}:${relPath}`)).version, "1.0.1");
  }
  f.assertRemoteUnchanged();
});

for (const mode of ["--dry-run", "--precheck"]) {
  test(`${mode} reports the configured check without executing it`, t => {
    const f = fixture(t, 23);
    const result = f.release("patch", mode);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.throws(() => readFileSync(f.gateLog), { code: "ENOENT" });
    f.assertNoRelease();
  });
}

test("obsolete --skip-local-check cannot bypass the release gate", t => {
  const f = fixture(t);
  const result = f.release("patch", "--skip-local-check");
  assert.equal(result.status, 1, result.stderr || result.stdout);
  f.assertNoRelease();
});

for (const checkCommand of [null, []]) {
  test(`invalid checkCommand ${JSON.stringify(checkCommand)} prevents a release`, t => {
    const f = fixture(t, 0, { checkCommand });
    const result = f.release("patch", "--no-push");
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.throws(() => readFileSync(f.gateLog), { code: "ENOENT" });
    f.assertNoRelease();
  });
}

for (const response of [
  { status: 1, stderr: "401 unauthorized" },
  { status: 1, stdout: '{"error":{"code":"E503"}}' },
  { status: 1, stderr: "connection timeout including misleading 404 text" },
  { status: 0, stdout: "{}" }, { status: 0, stdout: "" }, { status: 0, stdout: '[null]' },
]) {
  test("unknown registry state cannot create a release: " + JSON.stringify(response), t => {
    const f = fixture(t, 0, {}, response);
    const result = f.release("patch", "--no-push");
    assert.equal(result.status, 1);
    f.assertNoRelease();
  });
}

test("only an explicit registry E404 allows a first release plan", t => {
  const f = fixture(t, 0, {}, { status: 1, stdout: '{"error":{"code":"E404"}}' });
  const result = f.release("patch", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /next: 1\.0\.1/);
  f.assertNoRelease();
});

test("published versions newer than source determine the next version", t => {
  const f = fixture(t, 0, {}, { stdout: '["1.0.0","2.3.4"]' });
  const result = f.release("patch", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /next: 2\.3\.5/);
  assert.equal(f.release("2.0.0", "--dry-run").status, 1);
  f.assertNoRelease();
});

test("an unpublished failed tag is immutable and patch skips it", t => {
  const f = fixture(t);
  f.git("tag", "-a", "v1.0.1", "-m", "failed release fixture");
  const original = f.git("rev-parse", "v1.0.1");
  assert.equal(f.release("1.0.1", "--no-push").status, 1);
  const plan = f.release("patch", "--dry-run");
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /next: 1\.0\.2/);
  assert.equal(f.git("rev-parse", "v1.0.1"), original);
  f.assertRemoteUnchanged();
});

for (const args of [["1.0.1-beta.1"], ["patch", "--allow-branch"], ["patch", "--no-replace-failed-tag"]]) {
  test("unsupported release request cannot bypass stable main policy: " + args.join(" "), t => {
    const f = fixture(t);
    assert.equal(f.release(...args, "--no-push").status, 1);
    f.assertNoRelease();
  });
}

test("a local commit ahead of main and a side branch cannot release", t => {
  const f = fixture(t);
  f.git("switch", "-c", "work/fixture");
  assert.equal(f.release("patch", "--dry-run").status, 1);
  f.git("switch", "main");
  f.git("commit", "--allow-empty", "-m", "not integrated");
  const head = f.git("rev-parse", "HEAD");
  assert.equal(f.release("patch", "--no-push").status, 1);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.git("tag", "--list"), "");
  f.assertRemoteUnchanged();
});

test("--no-push still requires a current authoritative remote", t => {
  const f = fixture(t);
  f.git("remote", "remove", "origin");
  const result = f.release("patch", "--no-push");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Every mode requires current origin\/main/);
  f.assertNoRelease();
});

const candidate = {
  name: "pi-context-broker", packageVersion: "1.0.1", tag: "v1.0.1", mode: "new",
  brokerCommit: "a".repeat(40), cliCommit: "b".repeat(40), sha256: "c".repeat(64),
  integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64"),
};
const published = () => ({ name: candidate.name, version: candidate.packageVersion,
  dist: { integrity: candidate.integrity, attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/pi-context-broker@1.0.1" } } });

test("registry absence is exactly HTTP 404; errors, redirects and malformed documents are unknown", async () => {
  assert.deepEqual(await registryDocument("fixture", async (url, options) => {
    assert.equal(url, "https://registry.npmjs.org/fixture");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response("", { status: 404 });
  }), { kind: "absent" });
  for (const status of [401, 403, 429, 500, 301]) {
    await assert.rejects(registryDocument("fixture", async () => new Response("", { status })), /unknown/);
  }
  for (const body of ["{", "[]", "null"]) {
    await assert.rejects(registryDocument("fixture", async () => new Response(body, { status: 200 })));
  }
  await assert.rejects(registryDocument("fixture", async () => { throw new Error("timeout"); }), /timeout/);
  const actual = await registryDocument("fixture", async () => Response.json(published()));
  assert.equal(actual.kind, "present");
  assert.equal(actual.document.version, candidate.packageVersion);
});

test("lost publication acknowledgement skips duplicate publish only for exactly matching bytes", () => {
  const present = { kind: "present", document: published() }, absent = { kind: "absent" };
  assert.deepEqual(publicationDecision(candidate, present, present), { alreadyPublished: true });
  assert.deepEqual(publicationDecision(candidate, absent, absent), { alreadyPublished: false });
  assert.throws(() => publicationDecision({ ...candidate, mode: "repair" }, absent, absent), /repair cannot publish/);
  assert.throws(() => publicationDecision(candidate, { kind: "present", document: { ...published(), dist: { integrity: "wrong" } } }, present), /bytes differ/);
  assert.throws(() => publicationDecision(candidate, absent, { kind: "present", document: { name: candidate.name, version: "2.0.0" } }), /backward/);
  validateRegistry(candidate, published(), published(), false);
  validateRegistry(candidate, published(), { name: candidate.name, version: "2.0.0" }, true);
  assert.throws(() => validateRegistry(candidate, published(), { name: candidate.name, version: "2.0.0" }, false), /inconsistent/);
  assert.throws(() => validateRegistry(candidate, { ...published(), dist: { integrity: candidate.integrity } }, published(), false), /provenance/);
});

test("actual archive manifest is authoritative and rejects unresolved/local dependencies", async t => {
  const sandbox = mkdtempSync(join(tmpdir(), "broker-release-archive-"));
  t.diagnostic("Archive fixture retained at " + sandbox);
  mkdirSync(join(sandbox, "package"));
  const manifest = { name: candidate.name, version: candidate.packageVersion };
  const archive = join(sandbox, "pi-context-broker-1.0.1.tgz");
  const make = value => {
    writeFileSync(join(sandbox, "package/package.json"), JSON.stringify(value));
    const result = spawnSync("tar", ["-czf", archive, "package/"], { cwd: sandbox, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  make(manifest);
  const identity = await archiveIdentity(archive, candidate.packageVersion);
  assert.equal(identity.manifest.name, candidate.name);
  assert.match(identity.integrity, /^sha512-/);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies", "overrides", "resolutions"]) {
    for (const protocol of ["workspace:*", "catalog:", "file:../secret", "link:../secret"]) {
      assert.throws(() => validateManifest({ ...manifest, [field]: { fixture: protocol } }, candidate.packageVersion), /Unresolved/);
    }
  }
  make({ ...manifest, dependencies: { fixture: "catalog:" } });
  await assert.rejects(archiveIdentity(archive, candidate.packageVersion), /Unresolved/);
  assert.throws(() => stable("1.0.1-beta.1"), /stable/);
  assert.equal(compare("100000000000000000000.0.0", "2.0.0"), 1);
});

function provenance() {
  const statement = {
    subject: [{ name: "pkg:npm/pi-context-broker@1.0.1", digest: { sha512: Buffer.alloc(64, 1).toString("hex") } }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { repository: "https://github.com/yoyooyooo/pi-context-broker",
          path: ".github/workflows/publish.yml", ref: "refs/tags/v1.0.1" } },
        resolvedDependencies: [{ digest: { gitCommit: candidate.brokerCommit } }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  return { statement, audit(value = statement) { return {
    invalid: [], missing: [], verified: [{ name: candidate.name, version: candidate.packageVersion,
      registry: "https://registry.npmjs.org", attestationBundles: [{ predicateType: "https://slsa.dev/provenance/v1",
        bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(value)).toString("base64") } } }] }],
  }; } };
}

test("npm verified provenance must bind package bytes, repository, workflow, immutable ref and commit", () => {
  const p = provenance();
  assert.deepEqual(validateProvenance(candidate, p.audit()), p.statement);
  for (const mutate of [
    value => { value.subject[0].digest.sha512 = "wrong"; },
    value => { value.subject[0].name = "pkg:npm/other@1.0.1"; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/other/repo"; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main"; },
    value => { value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "d".repeat(40); },
    value => { value.predicate.runDetails.builder.id = "untrusted"; },
  ]) {
    const statement = structuredClone(p.statement); mutate(statement);
    assert.throws(() => validateProvenance(candidate, p.audit(statement)));
  }
  assert.throws(() => validateProvenance(candidate, { ...p.audit(), invalid: [{}] }));
  assert.throws(() => validateProvenance(candidate, { ...p.audit(), missing: [{}] }));
  assert.throws(() => validateProvenance(candidate, { ...p.audit(), verified: [] }));
});

test("GitHub repair reconciles duplicate calls and refuses unknown or mismatched assets before writing", () => {
  let release = null;
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === "api") return release ? { status: 0, stdout: JSON.stringify(release) } : { status: 1, stderr: "gh: Not Found (HTTP 404)" };
    if (args[1] === "create") release = { tag_name: candidate.tag, draft: false, assets: [] };
    if (args[1] === "upload") release.assets.push({ name: "pi-context-broker-1.0.1.tgz", digest: "sha256:" + candidate.sha256 });
    return { status: 0, stdout: "" };
  };
  const input = { candidate, archive: "/fixture/pi-context-broker-1.0.1.tgz", notes: "/fixture/notes.md", run };
  repairGitHubRelease(input);
  repairGitHubRelease(input);
  assert.equal(calls.filter(args => args[1] === "create").length, 1);
  assert.equal(calls.filter(args => args[1] === "upload").length, 1);
  assert.ok(calls.every(args => !args.includes("--clobber")));
  release.assets[0].digest = "sha256:wrong";
  const count = calls.length;
  assert.throws(() => repairGitHubRelease(input), /never overwrite/);
  assert.equal(calls.length, count + 1, "mismatch performs only the read");
  const errors = [];
  assert.throws(() => repairGitHubRelease({ ...input, run: args => { errors.push(args); return { status: 1, stderr: "503 timeout" }; } }), /unknown/);
  assert.equal(errors.length, 1);
  for (const response of [null, [], {}, { tag_name: candidate.tag, draft: false }]) {
    const malformed = [];
    assert.throws(() => repairGitHubRelease({ ...input, run: args => {
      malformed.push(args); return { status: 0, stdout: JSON.stringify(response) };
    } }), /malformed/);
    assert.equal(malformed.length, 1, "malformed success performs only the read");
  }
});

test("release source binds one annotated version-only commit to current main and exact paired CLI", async t => {
  const f = fixture(t);
  const cliRoot = join(f.sandbox, "cli");
  mkdirSync(cliRoot);
  f.git("-C", cliRoot, "init", "--initial-branch=main");
  f.git("-C", cliRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "CLI");
  const cliCommit = f.git("-C", cliRoot, "rev-parse", "HEAD");
  mkdirSync(join(f.repo, ".github/workflows"));
  for (const name of ["ci", "publish"]) writeFileSync(join(f.repo, ".github/workflows", name + ".yml"),
    "repository: yoyooyooo/notion-skills-cli\nref: " + cliCommit + "\n");
  const path = join(f.repo, "packages/context-broker/package.json");
  writeFileSync(path, JSON.stringify({ name: candidate.name, version: "1.0.0" }));
  f.git("add", "."); f.git("commit", "-m", "source baseline");
  f.git("--git-dir", f.remote, "fetch", f.repo, "HEAD:refs/heads/main");
  writeFileSync(path, JSON.stringify({ name: candidate.name, version: "1.0.1" }));
  f.git("add", "."); f.git("commit", "-m", "chore: release v1.0.1");
  f.git("tag", "-a", "v1.0.1", "-m", "v1.0.1");
  const input = { cwd: f.repo, cliRoot, tag: "v1.0.1", mode: "new" };
  const valid = await validateSource(input);
  assert.equal(valid.cliCommit, cliCommit);
  assert.equal(valid.brokerCommit, f.git("rev-parse", "HEAD"));
  f.git("--git-dir", f.remote, "fetch", f.repo, "HEAD:refs/heads/main");
  await assert.rejects(validateSource(input), /current origin\/main/);
  await validateSource({ ...input, mode: "repair" });
  writeFileSync(path, JSON.stringify({ name: candidate.name, version: "1.0.1", scripts: { malicious: "true" } }));
  await assert.rejects(validateSource({ ...input, mode: "repair" }), /clean/);
});
