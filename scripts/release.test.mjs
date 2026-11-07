import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const declaredConfig = JSON.parse(readFileSync(join(sourceRoot, ".github/release.config.json"), "utf8"));

function fixture(t, gateExit = 0, configOverrides = {}) {
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
  writeFileSync(npm, `#!${process.execPath}\nprocess.stdout.write('["1.0.0"]\\n');\n`);
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
  return { git, release, gateLog, baseline, config, assertNoRelease, assertRemoteUnchanged };
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

test("--dry-run reports the configured check without executing it", t => {
  const f = fixture(t, 23);
  const result = f.release("patch", "--dry-run");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.throws(() => readFileSync(f.gateLog), { code: "ENOENT" });
  f.assertNoRelease();
});

for (const gateExit of [0, 23]) {
  test(`--precheck executes the current checkout gate (${gateExit}) without creating a release`, t => {
    const f = fixture(t, gateExit);
    const result = f.release("patch", "--precheck");
    assert.equal(result.status, gateExit === 0 ? 0 : 1, result.stderr || result.stdout);
    const gate = JSON.parse(readFileSync(f.gateLog, "utf8"));
    assert.deepEqual(gate.versions, f.config.versionFiles.map(() => "1.0.0"));
    assert.equal(gate.branch, "main");
    assert.equal(gate.commits, "1");
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
